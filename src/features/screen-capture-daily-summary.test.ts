import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ScreenCaptureDailySummaryConfig } from "../config/screen-capture.js";
import { openScreenCaptureDb } from "../integrations/screen-capture/store.js";
import { QueueRepository } from "../queue/repository.js";
import { SourceHandlers } from "../queue/source-handlers.js";
import { cleanupExpiredCaptures } from "./screen-capture.js";
import {
  enqueueScreenCaptureDailySummary,
  registerScreenCaptureDailySource,
} from "./screen-capture-daily-summary.js";

const config: ScreenCaptureDailySummaryConfig = {
  enabled: true,
  groupName: "logbook",
  startDate: "2026-09-10",
  channelId: "123",
  prompt: "capturelogの{{date}}を要約してください",
  deliveryMode: "new-thread",
  sessionMode: "per-run",
  tools: [],
};
let directory: string;
let repository: QueueRepository;
let sources: SourceHandlers;
const resume = vi.fn();
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "screen-daily-"));
  vi.stubEnv("SCREEN_CAPTURE_DB_PATH", path.join(directory, "captures.sqlite"));
  repository = new QueueRepository(path.join(directory, "runtime.sqlite"));
  sources = new SourceHandlers();
  resume.mockReset();
  registerScreenCaptureDailySource(sources, repository, resume);
  repository.registerSources(sources);
});
afterEach(async () => {
  repository.close();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
function capture(timestamp: string, completed = true) {
  const db = openScreenCaptureDb();
  const id = randomUUID();
  db.prepare(
    "INSERT INTO screen_captures(id,image,received_at,completed_at) VALUES (?,?,?,?)",
  ).run(
    id,
    Buffer.from("image"),
    timestamp,
    completed ? "2020-01-01T00:00:00.000Z" : null,
  );
  db.close();
  return id;
}
function watermark() {
  const db = openScreenCaptureDb();
  const value = db
    .prepare(
      "SELECT watermark FROM screen_capture_daily_progress WHERE group_name = ?",
    )
    .get(config.groupName);
  db.close();
  return value;
}
async function success(callback = true) {
  const claim = repository.claim();
  if (!claim) throw new Error("missing daily job");
  repository.commitResult(claim.job.id, claim.fencingToken, "daily report");
  if (callback) await sources.terminal(claim.job);
  return claim.job;
}
const enqueue = () => enqueueScreenCaptureDailySummary(config, repository);

it("uses the JST capture boundary, waits for all batches, and enqueues once with configured delivery and prompt", async () => {
  capture("2026-09-10T14:59:59Z");
  const pending = capture("2026-09-10T14:59:58Z", false);
  await enqueue();
  expect(repository.claim()).toBeUndefined();
  capture("2026-09-10T15:00:00Z", false);
  await enqueue();
  expect(repository.claim()).toBeUndefined();
  const db = openScreenCaptureDb();
  db.prepare("UPDATE screen_captures SET completed_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    pending,
  );
  db.close();
  await enqueue();
  await enqueue();
  const job = repository.findByIdempotencyKey(
    "screen-capture-daily-summary:logbook:2026-09-10",
  );
  expect(job).toMatchObject({
    groupName: "logbook",
    channelId: "123",
    cronDeliveryMode: "new-thread",
    cronSessionMode: "per-run",
    configOverride: { tools: [] },
    feature: {
      kind: "screen-capture-daily-summary",
      input: { date: "2026-09-10" },
    },
    content: expect.stringContaining(
      "capturelogの2026-09-10を要約してください",
    ),
  });
  expect(
    repository.db.prepare("SELECT count(*) AS count FROM jobs").get(),
  ).toEqual({ count: 1 });
  expect(watermark()).toBeUndefined();
  await success();
  expect(watermark()).toEqual({ watermark: "2026-09-10" });
  expect(resume).toHaveBeenCalledWith("logbook");
});

it("catches up observed days oldest first after image GC, starting at the configured date", async () => {
  capture("2026-09-09T00:00:00Z");
  capture("2026-09-10T00:00:00Z");
  capture("2026-09-12T00:00:00Z");
  capture("2026-09-15T00:00:00Z");
  await cleanupExpiredCaptures();
  await enqueue();
  expect((await success()).feature?.input).toEqual({ date: "2026-09-10" });
  await enqueue();
  expect((await success()).feature?.input).toEqual({ date: "2026-09-12" });
  await enqueue();
  expect(repository.claim()).toBeUndefined();
  expect(watermark()).toEqual({ watermark: "2026-09-12" });
});

it("recovers a committed success after an interrupted completion callback and ignores late reported captures", async () => {
  capture("2026-09-10T00:00:00Z");
  capture("2026-09-11T00:00:00Z");
  capture("2026-09-12T00:00:00Z");
  await enqueue();
  await success(false);
  repository.close();
  repository = new QueueRepository(path.join(directory, "runtime.sqlite"));
  sources = new SourceHandlers();
  registerScreenCaptureDailySource(sources, repository, resume);
  repository.registerSources(sources);
  expect(watermark()).toBeUndefined();
  capture("2026-09-10T00:00:01Z");
  await enqueue();
  expect(watermark()).toEqual({ watermark: "2026-09-10" });
  expect((await success()).feature?.input).toEqual({ date: "2026-09-11" });
  await enqueue();
  expect(repository.claim()).toBeUndefined();
});

it("leaves failures unreported and retries the oldest day before later reports", async () => {
  for (const day of [10, 11, 12]) capture(`2026-09-${day}T00:00:00Z`);
  await enqueue();
  const claim = repository.claim();
  if (!claim) throw new Error("missing job");
  repository.deadLetter(
    claim.job.id,
    claim.fencingToken,
    "agent_failure",
    "failed",
  );
  await sources.terminal(claim.job);
  expect(watermark()).toBeUndefined();
  expect(resume).not.toHaveBeenCalled();
  await enqueue();
  expect((await success()).feature?.input).toEqual({ date: "2026-09-10" });
});
