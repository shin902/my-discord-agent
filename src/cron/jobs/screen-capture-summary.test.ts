import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMessage } from "../../agent/manager.js";
import { openScreenCaptureDb } from "../../integrations/screen-capture/store.js";
import type { CronContext } from "../runner.js";
import handler from "./screen-capture-summary.js";

vi.mock("../../agent/manager.js", () => ({ sendMessage: vi.fn() }));

const ctx = {
  id: "screen-capture-summary",
  schedule: "5m",
  enabled: true,
  groupName: "logbook",
  handler: "jobs/screen-capture-summary.ts",
} as CronContext;

describe("screen capture summary cron", () => {
  let directory: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    directory = await mkdtemp(path.join(os.tmpdir(), "screen-summary-"));
    vi.stubEnv(
      "SCREEN_CAPTURE_DB_PATH",
      path.join(directory, "captures.sqlite"),
    );
    vi.mocked(sendMessage).mockResolvedValue("done");
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

  it("runs one group agent with the configured batch and completes only it", async () => {
    const ids = insert(3);
    await handler({ ...ctx, settings: { limit: 2 } });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [groupName, , prompt] = vi.mocked(sendMessage).mock.calls[0];
    expect(groupName).toBe("logbook");
    for (const id of ids.slice(0, 2)) {
      const imagePath = path.join(
        process.cwd(),
        "groups/logbook/.screen-captures",
        `${id}.png`,
      );
      expect(prompt).toContain(`/workspace/.screen-captures/${id}.png`);
      await expect(readFile(imagePath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    expect(prompt).not.toContain(ids[2]);

    const db = openScreenCaptureDb();
    try {
      expect(
        db
          .prepare(
            "SELECT count(*) AS count FROM screen_captures WHERE completed_at IS NOT NULL",
          )
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });

  it("leaves images uncompleted when the agent fails", async () => {
    insert(2);
    vi.mocked(sendMessage).mockRejectedValue(new Error("agent failed"));
    await expect(handler(ctx)).rejects.toThrow("agent failed");

    const db = openScreenCaptureDb();
    try {
      expect(
        db
          .prepare(
            "SELECT count(*) AS count FROM screen_captures WHERE completed_at IS NULL",
          )
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });

  it("rejects a missing group or invalid settings", async () => {
    await expect(handler({ ...ctx, groupName: undefined })).rejects.toThrow(
      "requires valid settings and groupName",
    );
    await expect(
      handler({ ...ctx, settings: { timeoutMs: 0 } }),
    ).rejects.toThrow("requires valid settings and groupName");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
