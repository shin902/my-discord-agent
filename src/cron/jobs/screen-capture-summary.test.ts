import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMessage } from "../../agent/manager.js";
import { openScreenCaptureDb } from "../../integrations/screen-capture/store.js";
import type { CronContext } from "../runner.js";
import handler from "./screen-capture-summary.js";

const magickSimilarities = vi.hoisted(() => [] as number[]);
vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      _command: string,
      args: string[],
      callback: (...args: unknown[]) => void,
    ) =>
      callback(
        null,
        args.includes("SSIM") ? String(magickSimilarities.shift() ?? 0) : "",
        "",
      ),
  ),
}));
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
    magickSimilarities.length = 0;
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

  it("discards similar images and stops after accepting the configured limit", async () => {
    const ids = insert(5);
    magickSimilarities.push(0.95, 0.93, 0.6);

    await handler({ ...ctx, settings: { limit: 2 } });

    const prompt = vi.mocked(sendMessage).mock.calls[0][2];
    expect(prompt).toContain(ids[0]);
    expect(prompt).toContain(ids[3]);
    expect(prompt).not.toContain(ids[1]);
    expect(prompt).not.toContain(ids[2]);
    expect(prompt).not.toContain(ids[4]);

    const db = openScreenCaptureDb();
    try {
      expect(
        db
          .prepare(
            "SELECT id, accepted FROM screen_captures WHERE completed_at IS NOT NULL ORDER BY received_at, id",
          )
          .all(),
      ).toEqual([
        { id: ids[0], accepted: 1 },
        { id: ids[1], accepted: 0 },
        { id: ids[2], accepted: 0 },
        { id: ids[3], accepted: 1 },
      ]);
      expect(
        db
          .prepare("SELECT id FROM screen_captures WHERE completed_at IS NULL")
          .all(),
      ).toEqual([{ id: ids[4] }]);
    } finally {
      db.close();
    }
  });

  it("uses the previous run's last accepted image as its reference", async () => {
    const [previous, candidate] = insert(2);
    const db = openScreenCaptureDb();
    db.prepare(
      "UPDATE screen_captures SET completed_at = ?, accepted = 1 WHERE id = ?",
    ).run("2026-09-12T01:00:00Z", previous);
    db.close();
    magickSimilarities.push(0.9);

    await handler(ctx);

    expect(sendMessage).not.toHaveBeenCalled();
    const reopened = openScreenCaptureDb();
    try {
      expect(
        reopened
          .prepare("SELECT accepted FROM screen_captures WHERE id = ?")
          .get(candidate),
      ).toEqual({ accepted: 0 });
    } finally {
      reopened.close();
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
