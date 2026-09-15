import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
import { resolveModelConfig } from "../../config/default-model.js";
import { findGroupByName } from "../../config/groups.js";
import { resolveProviderConcurrency } from "../../config/providers.js";
import { openScreenCaptureDb } from "../../integrations/screen-capture/store.js";
import { acquireLlmLock } from "../../queue/llm-mutex.js";
import type { CronContext } from "../runner.js";
import handler from "./screen-capture-summary.js";

const magick = vi.hoisted(() => ({
  similarities: [] as number[],
  invalidIds: new Set<string>(),
  errorCode: undefined as string | number | undefined,
  comparisonExitCode: undefined as number | undefined,
  onExec: undefined as (() => void) | undefined,
}));
vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _command: string,
      args: string[],
      callback: (...args: unknown[]) => void,
    ) => {
      const onExec = magick.onExec;
      magick.onExec = undefined;
      onExec?.();
      const invalid = [...magick.invalidIds].some((id) =>
        args.some((arg) => arg.endsWith(`/${id}.png`)),
      );
      const errorCode =
        magick.errorCode ??
        (args.includes("SSIM") ? magick.comparisonExitCode : undefined);
      const error =
        errorCode || invalid
          ? Object.assign(new Error("magick failed"), {
              code: errorCode ?? 1,
            })
          : null;
      callback(
        error,
        args.includes("SSIM") ? (magick.similarities.shift() ?? 0) : "",
        invalid ? "improper image header @ error/png.c/ReadPNGImage/" : "",
      );
    },
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
vi.mock("../../config/default-model.js", () => ({
  resolveModelConfig: vi.fn(),
}));
vi.mock("../../config/groups.js", async (original) => ({
  ...(await original<typeof import("../../config/groups.js")>()),
  findGroupByName: vi.fn(),
}));
vi.mock("../../config/providers.js", () => ({
  resolveProviderConcurrency: vi.fn(),
}));
vi.mock("../../queue/llm-mutex.js", () => ({ acquireLlmLock: vi.fn() }));
vi.mock("../../proxy/credential-proxy-server.js", () => ({
  getProxyPort: () => 4242,
}));

const visionModel = { provider: "openai", modelId: "gpt-4o-mini" };
const memoryModel = { provider: "openai", modelId: "gpt-5" };
const agentConfig = {
  model: memoryModel,
  tools: ["read", "write"],
  approvalRequiredTools: ["write"],
  skills: ["memory"],
  mounts: [{ host: "data", container: "/data" }],
  contextFiles: [{ path: "memory/context.md", maxChars: 1000 }],
};
const ctx = {
  id: "screen-capture-summary",
  schedule: "5m",
  enabled: true,
  groupName: "logbook",
  handler: "jobs/screen-capture-summary.ts",
  ...agentConfig,
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
    magick.similarities.length = 0;
    magick.invalidIds.clear();
    magick.errorCode = undefined;
    magick.comparisonExitCode = undefined;
    magick.onExec = undefined;
    directory = await mkdtemp(path.join(os.tmpdir(), "screen-summary-"));
    vi.stubEnv(
      "SCREEN_CAPTURE_DB_PATH",
      path.join(directory, "captures.sqlite"),
    );
    vi.mocked(resolveModel).mockResolvedValue(model);
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      { provider: "openai", baseUrl: "https://api.openai.com/v1" },
    ]);
    vi.mocked(findGroupByName).mockResolvedValue({
      name: "logbook",
      channels: [],
      model: memoryModel,
    });
    vi.mocked(resolveModelConfig).mockImplementation(async (config) =>
      config
        ? { ...config, provider: config.provider ?? "openai" }
        : memoryModel,
    );
    vi.mocked(resolveProviderConcurrency).mockResolvedValue("parallel");
    vi.mocked(acquireLlmLock).mockResolvedValue(vi.fn());
    vi.mocked(completeSimple).mockResolvedValue(result());
    vi.mocked(sendMessage).mockResolvedValue("updated");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  function insert(count: number, start = 0) {
    const db = openScreenCaptureDb();
    try {
      return Array.from({ length: count }, (_, offset) => {
        const index = start + offset;
        const id = randomUUID();
        db.prepare(
          "INSERT INTO screen_captures (id, image, received_at) VALUES (?, ?, ?)",
        ).run(
          id,
          Buffer.from(`image-${index}`),
          `2026-09-12T00:00:${String(index).padStart(2, "0")}Z`,
        );
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

  it("accepts a limit above 10", async () => {
    await expect(
      handler({
        ...ctx,
        settings: { visionModel, concurrency: 2, limit: 30 },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects removed settings.timeoutMs configuration", async () => {
    await expect(
      handler({
        ...ctx,
        settings: { visionModel, concurrency: 2, timeoutMs: 10 },
      }),
    ).rejects.toThrow("requires valid settings and groupName");
  });

  it("summarizes images with settings.visionModel then gives text to the memory model", async () => {
    insert(2);
    await handler(ctx);

    expect(resolveModel).toHaveBeenCalledWith("openai", "gpt-4o-mini");
    expect(completeSimple).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledWith(
      "logbook",
      expect.stringMatching(/^cron-screen-capture-summary-/),
      expect.stringContaining("Editor work"),
      expect.objectContaining({ configOverride: agentConfig }),
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

  it("leaves captures added after the start-of-run watermark for the next run", async () => {
    insert(1);
    magick.onExec = () => insert(1, 1);

    await handler(ctx);

    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(rows().filter((row) => row.completed_at === null)).toHaveLength(1);

    vi.mocked(completeSimple).mockClear();
    await handler(ctx);
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(rows().every((row) => row.completed_at)).toBe(true);
  });

  it("leaves captures beyond the configured work budget pending", async () => {
    const ids = insert(3);
    await handler({
      ...ctx,
      settings: { visionModel, concurrency: 2, limit: 2 },
    });

    expect(completeSimple).toHaveBeenCalledTimes(2);
    expect(rows().find((row) => row.id === ids[2])).toMatchObject({
      summary: null,
      completed_at: null,
    });
  });

  it("accepts ImageMagick exit 1 when comparison returns a valid SSIM", async () => {
    insert(2);
    magick.similarities.push(0.2);
    magick.comparisonExitCode = 1;

    await handler(ctx);

    expect(sendMessage).toHaveBeenCalled();
    expect(rows().every((row) => row.accepted === 1 && row.completed_at)).toBe(
      true,
    );
  });

  it("rejects ImageMagick comparison exit 2", async () => {
    insert(2);
    magick.comparisonExitCode = 2;

    await expect(handler(ctx)).rejects.toMatchObject({ code: 2 });
  });

  it("scans a duplicate backlog while retaining only one selected image", async () => {
    const ids = insert(20);
    magick.similarities.push(...Array.from({ length: 19 }, () => 0.95));
    await handler(ctx);

    expect(completeSimple).toHaveBeenCalledTimes(1);
    const completed = rows();
    expect(completed.find((row) => row.id === ids[0])).toMatchObject({
      accepted: 1,
    });
    expect(completed.filter((row) => row.accepted === 0)).toHaveLength(19);
  });

  it("completes an invalid capture and continues with later captures", async () => {
    const ids = insert(2);
    magick.invalidIds.add(ids[0]);

    await handler(ctx);

    expect(rows()).toEqual([
      expect.objectContaining({
        id: ids[0],
        summary: null,
        accepted: 0,
        completed_at: expect.any(String),
      }),
      expect.objectContaining({
        id: ids[1],
        summary: "Editor work",
        accepted: 1,
        completed_at: expect.any(String),
      }),
    ]);
    expect(completeSimple).toHaveBeenCalledTimes(1);

    vi.mocked(completeSimple).mockClear();
    await handler(ctx);
    expect(completeSimple).not.toHaveBeenCalled();
  });

  it.each([
    "ENOENT",
    1,
  ])("does not mistake a magick infrastructure failure (%s) for invalid captures", async (errorCode) => {
    insert(2);
    magick.errorCode = errorCode;

    await expect(handler(ctx)).rejects.toMatchObject({ code: errorCode });
    expect(rows().every((row) => row.completed_at === null)).toBe(true);
  });

  it("propagates summary database write failures", async () => {
    insert(1);
    const db = openScreenCaptureDb();
    try {
      db.exec(`CREATE TRIGGER fail_summary_write
        BEFORE UPDATE OF summary ON screen_captures
        BEGIN SELECT RAISE(ABORT, 'summary storage failed'); END`);
    } finally {
      db.close();
    }

    await expect(handler(ctx)).rejects.toThrow("summary storage failed");
    expect(rows()[0]).toMatchObject({ summary: null, completed_at: null });
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

  it("passes more than 10 images to one locked direct-mode agent call", async () => {
    const ids = insert(12);
    const release = vi.fn();
    vi.mocked(resolveProviderConcurrency).mockResolvedValue("serial");
    vi.mocked(acquireLlmLock).mockResolvedValue(release);
    const directory = path.join(
      process.cwd(),
      "groups/logbook/.screen-captures",
    );
    vi.mocked(sendMessage).mockImplementationOnce(async () => {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      for (const id of ids)
        expect(
          (await stat(path.join(directory, `${id}.png`))).mode & 0o777,
        ).toBe(0o600);
      return "updated";
    });
    await handler({
      ...ctx,
      settings: { mode: "direct", limit: 12 },
    });

    expect(completeSimple).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      "logbook",
      expect.stringMatching(/^cron-screen-capture-summary-/),
      expect.stringContaining("未処理画像"),
      expect.objectContaining({
        imagePaths: ids.map((id) => `/workspace/.screen-captures/${id}.png`),
        configOverride: agentConfig,
        heldLlmProvider: memoryModel.provider,
      }),
    );
    expect(resolveProviderConcurrency).toHaveBeenCalledWith(
      memoryModel.provider,
    );
    expect(acquireLlmLock).toHaveBeenCalledWith(memoryModel.provider, "serial");
    expect(release).toHaveBeenCalledOnce();
    for (const id of ids) {
      await expect(
        readFile(path.join(directory, `${id}.png`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(rows().every((row) => row.accepted === 1 && row.completed_at)).toBe(
      true,
    );
  });

  it("omits configOverride when the cron has no AgentConfig fields", async () => {
    insert(1);
    await handler({
      ...ctx,
      model: undefined,
      tools: undefined,
      approvalRequiredTools: undefined,
      skills: undefined,
      mounts: undefined,
      contextFiles: undefined,
      settings: { mode: "direct" },
    });

    expect(vi.mocked(sendMessage).mock.calls[0][3]).not.toHaveProperty(
      "configOverride",
    );
  });

  it("leaves direct-mode images pending when the memory agent fails", async () => {
    insert(1);
    vi.mocked(sendMessage).mockRejectedValue(new Error("agent failed"));

    await expect(
      handler({ ...ctx, settings: { mode: "direct" } }),
    ).rejects.toThrow("agent failed");
    expect(rows()[0].completed_at).toBeNull();
  });

  it("rejects missing handler-specific configuration", async () => {
    await expect(handler({ ...ctx, settings: {} })).rejects.toThrow(
      "requires valid settings and groupName",
    );
    await expect(
      handler({ ...ctx, settings: { mode: "direct", timeoutMs: 1 } }),
    ).rejects.toThrow("requires valid settings and groupName");
    expect(completeSimple).not.toHaveBeenCalled();
  });
});
