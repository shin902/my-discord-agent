import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo, Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { loadRawConfig } from "../config/config.js";
import { openScreenCaptureDb } from "../integrations/screen-capture/store.js";
import { getQueueRepository, QueueRepository } from "../queue/repository.js";
import { SourceHandlers } from "../queue/source-handlers.js";
import { startScreenCapture } from "./screen-capture.js";

vi.mock("../config/config.js", () => ({ loadRawConfig: vi.fn() }));
vi.mock("../queue/repository.js", async (original) => ({
  ...(await original<typeof import("../queue/repository.js")>()),
  getQueueRepository: vi.fn(),
}));
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_command, _args, callback) => callback(null, "", "")),
}));

it("triggers a separate daily job from upload and successful full-batch completion, and resumes on daily success", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "screen-daily-pipeline-"),
  );
  vi.stubEnv("SCREEN_CAPTURE_DB_PATH", path.join(directory, "captures.sqlite"));
  const repository = new QueueRepository(
    path.join(directory, "runtime.sqlite"),
  );
  vi.mocked(getQueueRepository).mockReturnValue(repository);
  const sources = new SourceHandlers();
  repository.registerSources(sources);
  vi.mocked(loadRawConfig).mockResolvedValue({
    screenCaptureReceiver: { enabled: true, port: 8788 },
    screenCaptureSummary: {
      enabled: true,
      groupName: "daily-integration",
      settings: { mode: "direct", limit: 2 },
    },
    screenCaptureDailySummary: {
      enabled: true,
      groupName: "daily-integration",
      startDate: "2026-09-10",
      prompt: "{{date}}を要約",
      channelId: "123",
      tools: [],
    },
  });
  // The production receiver schema disallows ephemeral port 0; override only its port loader.
  const receiverConfig = await import("../config/screen-capture.js");
  const port = vi
    .spyOn(receiverConfig, "loadScreenCaptureReceiverConfig")
    .mockResolvedValue({ enabled: true, port: 0 });
  let server: Server | undefined;
  try {
    server = await startScreenCapture(sources);
    async function upload(timestamp: string) {
      const response = await fetch(
        `http://127.0.0.1:${(server?.address() as AddressInfo).port}/v1/screen-captures`,
        {
          method: "POST",
          headers: {
            "Content-Type": "image/png",
            "X-Capture-Id": randomUUID(),
            "X-Captured-At": timestamp,
          },
          body: Buffer.from("89504e470d0a1a0a01020304", "hex"),
        },
      );
      expect(response.status).toBe(200);
    }
    await upload("2026-09-10T00:00:00Z");
    await upload("2026-09-11T00:00:00Z");
    await vi.waitFor(() =>
      expect(
        repository.db.prepare("SELECT count(*) AS n FROM jobs").get(),
      ).toEqual({ n: 1 }),
    );
    const batch = repository.claim();
    if (!batch) throw new Error("missing batch");
    expect(batch.job.feature?.kind).toBe("screen-capture");
    repository.commitResult(batch.job.id, batch.fencingToken, "", {
      suppressDelivery: true,
    });
    await sources.terminal(batch.job);
    const key = "screen-capture-daily-summary:daily-integration:2026-09-10";
    await vi.waitFor(() =>
      expect(repository.findByIdempotencyKey(key)).toBeDefined(),
    );
    const daily = repository.claim();
    if (!daily) throw new Error("missing daily job");
    expect(daily.job.feature).toEqual({
      kind: "screen-capture-daily-summary",
      input: { date: "2026-09-10" },
    });
    repository.commitResult(daily.job.id, daily.fencingToken, "report");
    await sources.terminal(daily.job);
    await upload("2026-09-12T00:00:00Z");
    await vi.waitFor(() =>
      expect(
        repository.findByIdempotencyKey(
          "screen-capture-daily-summary:daily-integration:2026-09-11",
        ),
      ).toBeDefined(),
    );
    const db = openScreenCaptureDb();
    expect(
      db.prepare("SELECT watermark FROM screen_capture_daily_progress").get(),
    ).toEqual({ watermark: "2026-09-10" });
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM screen_captures WHERE completed_at IS NULL",
        )
        .get(),
    ).toEqual({ n: 1 });
    db.close();
  } finally {
    if (server)
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    port.mockRestore();
    repository.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
