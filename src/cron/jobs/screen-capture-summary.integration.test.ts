import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

import type { CredentialEntry } from "../../config/credential-proxy.js";
import {
  registerScreenCaptureSource,
  summarizeScreenCaptureBatch,
} from "../../features/screen-capture-summary.js";
import { startScreenCaptureReceiver } from "../../integrations/screen-capture/receiver.js";
import { openScreenCaptureDb } from "../../integrations/screen-capture/store.js";
import { createRequestHandler } from "../../proxy/credential-proxy-server.js";
import { QueueRepository } from "../../queue/repository.js";
import { SourceHandlers } from "../../queue/source-handlers.js";
import type { CronContext } from "../runner.js";

const handler = (ctx: CronContext) =>
  summarizeScreenCaptureBatch(
    ctx as Parameters<typeof summarizeScreenCaptureBatch>[0],
  );

const queue = vi.hoisted(() => ({
  repository: undefined as QueueRepository | undefined,
}));
vi.mock("../../queue/repository.js", async (original) => ({
  ...(await original<typeof import("../../queue/repository.js")>()),
  getQueueRepository: () => queue.repository,
}));
const state = vi.hoisted(() => ({ port: 0, entries: [] as CredentialEntry[] }));
vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _command: string,
      _args: string[],
      callback: (...args: unknown[]) => void,
    ) => callback(null, "", ""),
  ),
}));
vi.mock("../../agent/manager.js", () => ({ sendMessage: vi.fn() }));
vi.mock("../session-retention.js", () => ({
  markEphemeralCronSession: vi.fn(),
}));
vi.mock("../../config/credential-proxy.js", () => ({
  loadCredentialProxy: async () => state.entries,
}));
vi.mock("../../config/providers.js", () => ({
  resolveProviderLockTarget: async () => ({
    provider: "provider-a",
    resource: "provider-a",
    concurrency: "parallel" as const,
  }),
}));
vi.mock("../../proxy/credential-proxy-server.js", async (original) => ({
  ...(await original<
    typeof import("../../proxy/credential-proxy-server.js")
  >()),
  getProxyPort: () => state.port,
}));

it("runs upload → VLM through Credential Proxy → DB summary → durable Memory Agent job", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "screen-pipeline-"));
  const servers: Server[] = [];
  async function listen(server: Server) {
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    return (server.address() as AddressInfo).port;
  }
  vi.stubEnv("SCREEN_CAPTURE_DB_PATH", path.join(directory, "captures.sqlite"));
  vi.stubEnv("SCREEN_PIPELINE_KEY", "fixture-host-secret");
  const repository = new QueueRepository(
    path.join(directory, "runtime.sqlite"),
  );
  queue.repository = repository;
  const sources = new SourceHandlers();
  registerScreenCaptureSource(sources, repository, () => {});
  repository.registerSources(sources);

  try {
    let request:
      | { headers: IncomingHttpHeaders; url?: string; body: string }
      | undefined;
    const upstreamPort = await listen(
      createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        request = { headers: req.headers, url: req.url, body };
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          [
            `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "vision-test", choices: [{ index: 0, delta: { role: "assistant", content: "エディタでコードを編集している。" }, finish_reason: null }] })}\n\n`,
            `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "vision-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
            "data: [DONE]\n\n",
          ].join(""),
        );
      }),
    );
    state.entries = [
      {
        provider: "screen-test",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        envVars: ["SCREEN_PIPELINE_KEY"],
        models: { "vision-test": { input: ["text", "image"] } },
      },
    ];
    state.port = await listen(
      createServer(createRequestHandler(state.entries, 5000)),
    );
    const receiver = await startScreenCaptureReceiver({ port: 0 });
    servers.push(receiver);
    const id = randomUUID();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6D1sAAAAASUVORK5CYII=",
      "base64",
    );
    const response = await fetch(
      `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/v1/screen-captures`,
      {
        method: "POST",
        headers: {
          "Content-Type": "image/png",
          "X-Capture-Id": id,
          "X-Captured-At": "2025-01-02T03:04:05Z",
        },
        body: png,
      },
    );
    expect(await response.json()).toEqual({ accepted: id });

    const memoryModel = { provider: "openai", modelId: "gpt-5" };
    await handler({
      id: "screen-capture-summary",
      schedule: "5m",
      enabled: true,
      groupName: "logbook",
      handler: "jobs/screen-capture-summary.ts",
      model: memoryModel,
      settings: {
        visionModel: { provider: "screen-test", modelId: "vision-test" },
        limit: 1,
      },
    } as CronContext);

    expect(request?.headers.authorization).toBe("Bearer fixture-host-secret");
    expect(request?.url).toBe("/v1/chat/completions");
    const wire = JSON.parse(request?.body ?? "{}");
    expect(wire.messages.at(-1).content).toContainEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${png.toString("base64")}` },
    });
    const job = repository.claim()?.job;
    expect(job).toMatchObject({
      content: expect.stringContaining("エディタでコードを編集している。"),
      configOverride: { model: memoryModel },
      discordOutput: "none",
    });
    const db = openScreenCaptureDb();
    try {
      expect(
        db
          .prepare(
            "SELECT summary, accepted, completed_at IS NOT NULL AS completed FROM screen_captures WHERE id = ?",
          )
          .get(id),
      ).toEqual({
        summary: "エディタでコードを編集している。",
        accepted: null,
        completed: 0,
      });
    } finally {
      db.close();
    }
  } finally {
    for (const server of servers.reverse()) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    repository.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
