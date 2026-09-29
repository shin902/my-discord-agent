import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo, Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadScreenCaptureReceiverConfig,
  loadScreenCaptureSummaryConfig,
  type ScreenCaptureSummaryConfig,
} from "../config/screen-capture.js";
import { openScreenCaptureDb } from "../integrations/screen-capture/store.js";
import { startScreenCapture } from "./screen-capture.js";
import { summarizeScreenCaptureBatch } from "./screen-capture-summary.js";

vi.mock("../config/screen-capture.js", () => ({
  loadScreenCaptureReceiverConfig: vi.fn(),
  loadScreenCaptureSummaryConfig: vi.fn(),
}));
vi.mock("./screen-capture-summary.js", () => ({
  summarizeScreenCaptureBatch: vi.fn(),
}));

const image = Buffer.from("89504e470d0a1a0a01020304", "hex");
const settings: ScreenCaptureSummaryConfig = {
  enabled: true,
  groupName: "logbook",
  settings: { mode: "direct", limit: 2 },
};

let server: Server | undefined;
let directory: string;

async function upload() {
  const response = await fetch(
    `http://127.0.0.1:${(server?.address() as AddressInfo).port}/v1/screen-captures`,
    {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        "X-Capture-Id": randomUUID(),
        "X-Captured-At": "2026-09-12T00:00:00Z",
      },
      body: image,
    },
  );
  expect(response.status).toBe(200);
}

function pending() {
  const db = openScreenCaptureDb();
  try {
    return (
      db
        .prepare(
          "SELECT count(*) AS count FROM screen_captures WHERE completed_at IS NULL",
        )
        .get() as { count: number }
    ).count;
  } finally {
    db.close();
  }
}

describe("screen capture event consumer", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    directory = await mkdtemp(path.join(os.tmpdir(), "screen-consumer-"));
    vi.stubEnv(
      "SCREEN_CAPTURE_DB_PATH",
      path.join(directory, "captures.sqlite"),
    );
    vi.mocked(loadScreenCaptureReceiverConfig).mockResolvedValue({
      enabled: true,
      port: 0,
    });
    vi.mocked(loadScreenCaptureSummaryConfig).mockResolvedValue(settings);
  });

  afterEach(async () => {
    if (server)
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("waits for the limit, serializes concurrent uploads and drains oldest batches", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const batches: string[][] = [];
    vi.mocked(summarizeScreenCaptureBatch).mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        const db = openScreenCaptureDb();
        const ids = (
          db
            .prepare(
              "SELECT id FROM screen_captures WHERE completed_at IS NULL ORDER BY received_at, id LIMIT 2",
            )
            .all() as { id: string }[]
        ).map(({ id }) => id);
        db.close();
        if (ids.length < 2) return false;
        batches.push(ids);
        if (batches.length === 1) await gate;
        const write = openScreenCaptureDb();
        write
          .prepare(
            "UPDATE screen_captures SET completed_at = ? WHERE id IN (?, ?)",
          )
          .run(new Date().toISOString(), ...ids);
        write.close();
        return true;
      } finally {
        active--;
      }
    });
    server = await startScreenCapture();
    await vi.waitFor(() =>
      expect(summarizeScreenCaptureBatch).toHaveBeenCalledTimes(1),
    ); // startup recovery
    await upload();
    await vi.waitFor(() =>
      expect(summarizeScreenCaptureBatch).toHaveBeenCalledTimes(2),
    );
    expect(batches).toHaveLength(0);
    await upload();
    await vi.waitFor(() => expect(batches).toHaveLength(1));
    await Promise.all([upload(), upload(), upload()]);
    expect(maxActive).toBe(1);
    release();
    await vi.waitFor(() => expect(batches).toHaveLength(2));
    await vi.waitFor(() => expect(pending()).toBe(1));
    expect(batches[0]).not.toEqual(batches[1]);
    expect(maxActive).toBe(1);
  });

  it("recovers a full pending batch on startup, leaving failures pending", async () => {
    const db = openScreenCaptureDb();
    for (let n = 0; n < 2; n++)
      db.prepare(
        "INSERT INTO screen_captures(id, image, received_at) VALUES (?, ?, ?)",
      ).run(randomUUID(), image, `2026-09-12T00:00:0${n}Z`);
    db.close();
    vi.mocked(summarizeScreenCaptureBatch).mockRejectedValueOnce(
      new Error("agent failed"),
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      server = await startScreenCapture();
      await vi.waitFor(() => expect(error).toHaveBeenCalled());
      expect(pending()).toBe(2);
      expect(summarizeScreenCaptureBatch).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });
});
