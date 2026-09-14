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
import { sendMessage } from "../../agent/manager.js";
import { resolveModel } from "../../agent/model.js";
import { loadCredentialProxy } from "../../config/credential-proxy.js";
import { resolveProviderConcurrency } from "../../config/providers.js";
import { openScreenCaptureDb } from "../../integrations/screen-capture/store.js";
import type { CronContext } from "../runner.js";
import handler from "./screen-capture-summary.js";

const similarities = vi.hoisted(() => [] as number[]);
vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _command: string,
      args: string[],
      callback: (...args: unknown[]) => void,
    ) =>
      callback(
        null,
        args.includes("SSIM") ? (similarities.shift() ?? 0) : "",
        "",
      ),
  ),
}));
vi.mock("@earendil-works/pi-ai/compat", async (original) => ({
  ...(await original<typeof import("@earendil-works/pi-ai/compat")>()),
  completeSimple: vi.fn(),
}));
vi.mock("../../agent/model.js", () => ({ resolveModel: vi.fn() }));
vi.mock("../../agent/manager.js", () => ({ sendMessage: vi.fn() }));
vi.mock("../../config/credential-proxy.js", () => ({
  loadCredentialProxy: vi.fn(),
}));
vi.mock("../../config/providers.js", () => ({
  resolveProviderConcurrency: vi.fn(),
}));
vi.mock("../../proxy/credential-proxy-server.js", () => ({
  getProxyPort: () => 4242,
}));

const visionModel = { provider: "openai", modelId: "gpt-4o-mini" };
const memoryModel = { provider: "openai", modelId: "gpt-5" };
const ctx = {
  id: "screen-capture-summary",
  schedule: "5m",
  enabled: true,
  groupName: "logbook",
  handler: "jobs/screen-capture-summary.ts",
  model: memoryModel,
  settings: { visionModel, concurrency: 2, limit: 10 },
} as CronContext;
const model = getModel("openai", "gpt-4o-mini");

function result(text = "Editor work"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
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
    similarities.length = 0;
    directory = await mkdtemp(path.join(os.tmpdir(), "screen-summary-"));
    vi.stubEnv(
      "SCREEN_CAPTURE_DB_PATH",
      path.join(directory, "captures.sqlite"),
    );
    vi.mocked(resolveModel).mockResolvedValue(model);
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      { provider: "openai", baseUrl: "https://api.openai.com/v1" },
    ]);
    vi.mocked(resolveProviderConcurrency).mockResolvedValue("parallel");
    vi.mocked(completeSimple).mockResolvedValue(result());
    vi.mocked(sendMessage).mockResolvedValue("updated");
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
        ).run(id, Buffer.from(`image-${index}`), `2026-09-12T00:00:0${index}Z`);
        return id;
      });
    } finally {
      db.close();
    }
  }

  function rows() {
    const db = openScreenCaptureDb();
    try {
      return db
        .prepare(
          "SELECT id, summary, accepted, completed_at FROM screen_captures ORDER BY received_at, id",
        )
        .all() as {
        id: string;
        summary: string | null;
        accepted: number | null;
        completed_at: string | null;
      }[];
    } finally {
      db.close();
    }
  }

  it("summarizes images with settings.visionModel then gives text to the memory model", async () => {
    insert(2);
    await handler(ctx);

    expect(resolveModel).toHaveBeenCalledWith("openai", "gpt-4o-mini");
    expect(completeSimple).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith(
      "logbook",
      expect.stringMatching(/^cron-screen-capture-summary-/),
      expect.stringContaining("Editor work"),
      expect.objectContaining({ configOverride: { model: memoryModel } }),
    );
    expect(vi.mocked(sendMessage).mock.calls[0][2]).not.toContain(".png");
    expect(
      rows().every(
        (row) =>
          row.summary === "Editor work" &&
          row.accepted === 1 &&
          row.completed_at,
      ),
    ).toBe(true);
  });

  it("keeps VLM summaries pending when memory update fails and reuses them", async () => {
    insert(1);
    vi.mocked(sendMessage).mockRejectedValueOnce(new Error("agent failed"));
    await expect(handler(ctx)).rejects.toThrow("agent failed");
    expect(rows()[0]).toMatchObject({
      summary: "Editor work",
      completed_at: null,
    });

    vi.mocked(completeSimple).mockClear();
    await handler(ctx);
    expect(completeSimple).not.toHaveBeenCalled();
    expect(rows()[0].completed_at).not.toBeNull();
  });

  it("skips similar images without calling the VLM", async () => {
    const ids = insert(2);
    similarities.push(0.95);
    await handler(ctx);

    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([
      expect.objectContaining({ id: ids[0], accepted: 1 }),
      expect.objectContaining({ id: ids[1], summary: null, accepted: 0 }),
    ]);
  });

  it("leaves only failed VLM images pending", async () => {
    insert(2);
    vi.mocked(completeSimple)
      .mockRejectedValueOnce(new Error("provider failure"))
      .mockResolvedValueOnce(result("success"));
    await handler(ctx);

    expect(rows().filter((row) => row.completed_at === null)).toEqual([
      expect.objectContaining({ summary: null }),
    ]);
    expect(sendMessage).toHaveBeenCalledWith(
      "logbook",
      expect.any(String),
      expect.stringContaining("success"),
      expect.any(Object),
    );
  });

  it("rejects missing handler-specific configuration", async () => {
    await expect(handler({ ...ctx, settings: {} })).rejects.toThrow(
      "requires valid settings and groupName",
    );
    expect(completeSimple).not.toHaveBeenCalled();
  });
});
