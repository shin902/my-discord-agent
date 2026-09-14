import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

const magick = vi.hoisted(() => ({
  similarities: [] as number[],
  invalidIds: new Set<string>(),
  errorCode: undefined as string | number | undefined,
}));
vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _command: string,
      args: string[],
      callback: (...args: unknown[]) => void,
    ) => {
      const invalid = [...magick.invalidIds].some((id) =>
        args.some((arg) => arg.endsWith(`/${id}.png`)),
      );
      const error =
        magick.errorCode || invalid
          ? Object.assign(new Error("magick failed"), {
              code: magick.errorCode ?? 1,
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
    magick.similarities.length = 0;
    magick.invalidIds.clear();
    magick.errorCode = undefined;
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

  it("stops fetching captures when the accepted limit is reached", async () => {
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

  it("passes selected images directly to the memory agent in direct mode", async () => {
    const ids = insert(2);
    await handler({
      ...ctx,
      settings: { mode: "direct", timeoutMs: 120_000, limit: 10 },
    });

    expect(completeSimple).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      "logbook",
      expect.stringMatching(/^cron-screen-capture-summary-/),
      expect.stringContaining("未処理画像"),
      expect.objectContaining({
        imagePaths: ids.map((id) => `/workspace/.screen-captures/${id}.png`),
      }),
    );
    for (const id of ids) {
      await expect(
        readFile(
          path.join(
            process.cwd(),
            "groups/logbook/.screen-captures",
            `${id}.png`,
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(rows().every((row) => row.accepted === 1 && row.completed_at)).toBe(
      true,
    );
  });

  it("leaves direct-mode images pending when the memory agent fails", async () => {
    insert(1);
    vi.mocked(sendMessage).mockRejectedValue(new Error("agent failed"));

    await expect(
      handler({ ...ctx, settings: { mode: "direct", limit: 10 } }),
    ).rejects.toThrow("agent failed");
    expect(rows()[0].completed_at).toBeNull();
  });

  it("rejects missing handler-specific configuration", async () => {
    await expect(handler({ ...ctx, settings: {} })).rejects.toThrow(
      "requires valid settings and groupName",
    );
    await expect(
      handler({ ...ctx, settings: { mode: "direct", timeoutMs: 0 } }),
    ).rejects.toThrow("requires valid settings and groupName");
    await expect(
      handler({ ...ctx, settings: { mode: "direct", limit: 11 } }),
    ).rejects.toThrow("requires valid settings and groupName");
    expect(completeSimple).not.toHaveBeenCalled();
  });
});
