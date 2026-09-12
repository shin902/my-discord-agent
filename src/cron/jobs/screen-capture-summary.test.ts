import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type AssistantMessage,
  completeSimple,
  getModel,
} from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveModel } from "../../agent/model.js";
import { loadCredentialProxy } from "../../config/credential-proxy.js";
import { resolveModelConfig } from "../../config/default-model.js";
import { resolveProviderConcurrency } from "../../config/providers.js";
import { openScreenCaptureDb } from "../../integrations/screen-capture/store.js";
import { acquireLlmLock } from "../../queue/llm-mutex.js";
import type { CronContext } from "../runner.js";
import handler from "./screen-capture-summary.js";

vi.mock("@earendil-works/pi-ai/compat", async (original) => ({
  ...(await original<typeof import("@earendil-works/pi-ai/compat")>()),
  completeSimple: vi.fn(),
}));
vi.mock("../../agent/model.js", () => ({ resolveModel: vi.fn() }));
vi.mock("../../config/credential-proxy.js", () => ({
  loadCredentialProxy: vi.fn(),
}));
vi.mock("../../config/default-model.js", () => ({
  resolveModelConfig: vi.fn(),
}));
vi.mock("../../config/providers.js", () => ({
  resolveProviderConcurrency: vi.fn(),
}));
vi.mock("../../proxy/credential-proxy-server.js", () => ({
  getProxyPort: () => 4242,
}));

const ctx = {
  id: "screen-capture-summary",
  schedule: "5m",
  enabled: true,
  handler: "jobs/screen-capture-summary.ts",
  model: { provider: "openai", modelId: "gpt-4o-mini" },
  settings: { concurrency: 2 },
} as CronContext;
const model = getModel("openai", "gpt-4o-mini");
function result(
  text = "Editor work",
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

describe("screen capture summary cron", () => {
  let directory: string;
  beforeEach(async () => {
    vi.resetAllMocks();
    directory = await mkdtemp(path.join(os.tmpdir(), "screen-summary-"));
    vi.stubEnv(
      "SCREEN_CAPTURE_DB_PATH",
      path.join(directory, "captures.sqlite"),
    );
    vi.stubEnv("SCREEN_CAPTURE_TEST_KEY", "host-only-secret");
    vi.mocked(resolveModelConfig).mockResolvedValue({
      provider: "openai",
      modelId: "gpt-4o-mini",
    });
    vi.mocked(resolveModel).mockResolvedValue(model);
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      {
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        envVars: ["SCREEN_CAPTURE_TEST_KEY"],
      },
    ]);
    vi.mocked(resolveProviderConcurrency).mockResolvedValue("parallel");
    vi.mocked(completeSimple).mockResolvedValue(result());
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  function insert(count: number) {
    const db = openScreenCaptureDb();
    try {
      return Array.from({ length: count }, (_, index) => {
        const id = randomUUID();
        db.prepare(
          "INSERT INTO screen_captures (id, image, received_at) VALUES (?, ?, ?)",
        ).run(id, Buffer.from(id), `2026-09-12T00:00:0${index}.000Z`);
        return id;
      });
    } finally {
      db.close();
    }
  }
  function rows() {
    const db = openScreenCaptureDb();
    try {
      return db.prepare("SELECT id, summary FROM screen_captures").all() as {
        id: string;
        summary: string | null;
      }[];
    } finally {
      db.close();
    }
  }

  it("snapshots all unread IDs, runs bounded parallel work and retries only failures / new arrivals", async () => {
    const ids = insert(5);
    const finish: ((value: AssistantMessage) => void)[] = [];
    vi.mocked(completeSimple).mockImplementation(
      () => new Promise((resolve) => finish.push(resolve)),
    );
    const run = handler(ctx);
    await vi.waitFor(() => expect(finish).toHaveLength(2));
    const [newId] = insert(1);
    finish[0](result(" first summary "));
    finish[1](result("partial text", "error"));
    await vi.waitFor(() => expect(finish).toHaveLength(4));
    finish[2](result(""));
    finish[3](result("cut off", "length"));
    await vi.waitFor(() => expect(finish).toHaveLength(5));
    finish[4](result("last summary"));
    await run;
    expect(rows().filter((row) => row.summary !== null)).toEqual([
      { id: ids[0], summary: "first summary" },
      { id: ids[4], summary: "last summary" },
    ]);
    expect(rows().find((row) => row.id === newId)?.summary).toBeNull();
    expect(completeSimple).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "http://127.0.0.1:4242/openai" }),
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: [
              expect.objectContaining({ type: "text" }),
              {
                type: "image",
                data: Buffer.from(ids[0]).toString("base64"),
                mimeType: "image/png",
              },
            ],
          }),
        ],
      }),
      expect.objectContaining({
        apiKey: "local",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(JSON.stringify(vi.mocked(completeSimple).mock.calls)).not.toContain(
      "host-only-secret",
    );
    expect(vi.mocked(completeSimple).mock.calls[0][1]).not.toHaveProperty(
      "tools",
    );
    expect(resolveModelConfig).toHaveBeenCalledWith(ctx.model);

    vi.mocked(completeSimple)
      .mockClear()
      .mockResolvedValue(result("retry success"));
    await handler(ctx);
    expect(completeSimple).toHaveBeenCalledTimes(4);
    expect(rows().every((row) => row.summary !== null)).toBe(true);
    vi.mocked(completeSimple).mockClear();
    await handler(ctx);
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it("leaves thrown and timed-out calls unread and releases the provider lock", async () => {
    insert(2);
    vi.mocked(resolveProviderConcurrency).mockResolvedValue("serial");
    vi.mocked(completeSimple)
      .mockRejectedValueOnce(new Error("provider failure"))
      .mockImplementationOnce(
        (_model, _context, options) =>
          new Promise((resolve) => {
            options?.signal?.addEventListener(
              "abort",
              () => resolve(result("partial", "aborted")),
              { once: true },
            );
          }),
      );
    await handler({ ...ctx, settings: { timeoutMs: 30 } });
    expect(rows().every((row) => row.summary === null)).toBe(true);
    const release = await acquireLlmLock(
      "openai",
      "serial",
      AbortSignal.timeout(1000),
    );
    release();
    await handler(ctx);
    expect(rows().every((row) => row.summary !== null)).toBe(true);
  });

  it("honors the shared serial provider policy", async () => {
    insert(2);
    vi.mocked(resolveProviderConcurrency).mockResolvedValue("serial");
    const release = await acquireLlmLock("openai", "serial");
    const run = handler(ctx);
    await vi.waitFor(() =>
      expect(resolveProviderConcurrency).toHaveBeenCalled(),
    );
    expect(completeSimple).not.toHaveBeenCalled();
    release();
    await run;
    expect(completeSimple).toHaveBeenCalledTimes(2);
  });

  it("does not mark a failed SQLite update read, and drains other workers before closing", async () => {
    const ids = insert(2);
    const db = openScreenCaptureDb();
    db.exec(
      `CREATE TRIGGER fail_summary BEFORE UPDATE ON screen_captures WHEN NEW.id = '${ids[0]}' BEGIN SELECT RAISE(ABORT, 'write failed'); END`,
    );
    const finish: ((value: AssistantMessage) => void)[] = [];
    vi.mocked(completeSimple).mockImplementation(
      () => new Promise((resolve) => finish.push(resolve)),
    );
    const run = handler(ctx);
    const failed = expect(run).rejects.toThrow("write failed");
    try {
      await vi.waitFor(() => expect(finish).toHaveLength(2));
      finish[0](result());
      finish[1](result());
      await failed;
      expect(rows()).toEqual([
        { id: ids[0], summary: null },
        { id: ids[1], summary: "Editor work" },
      ]);
      db.exec("DROP TRIGGER fail_summary");
      vi.mocked(completeSimple).mockResolvedValue(result());
      await handler(ctx);
      expect(rows().every((row) => row.summary !== null)).toBe(true);
    } finally {
      db.close();
    }
  });

  it.each([
    { ...model, input: ["text"] as ["text"] },
    { ...model, api: "openai-codex-responses" as const },
  ])("rejects non-vision or unsupported transports before any call", async (invalidModel) => {
    insert(1);
    vi.mocked(resolveModel).mockResolvedValue(invalidModel);
    await expect(handler(ctx)).rejects.toThrow("requires a vision model");
    expect(completeSimple).not.toHaveBeenCalled();
    expect(rows()[0].summary).toBeNull();
  });

  it.each([
    { concurrency: 0 },
    { concurrency: 17 },
    { timeoutMs: 0 },
    { limit: 2 },
  ])("rejects invalid settings %j", async (settings) => {
    await expect(handler({ ...ctx, settings })).rejects.toThrow(
      "Invalid screen-capture-summary settings",
    );
    expect(completeSimple).not.toHaveBeenCalled();
  });
});
