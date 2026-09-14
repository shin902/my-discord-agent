import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMessage } from "../../agent/manager.js";
import { openScreenCaptureDb } from "../../integrations/screen-capture/store.js";
import type { CronContext } from "../runner.js";
import handler from "./screen-capture-summary-direct.js";

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
vi.mock("../../agent/manager.js", () => ({ sendMessage: vi.fn() }));

const ctx = {
  id: "screen-capture-summary",
  schedule: "5m",
  enabled: true,
  groupName: "logbook",
  handler: "jobs/screen-capture-summary-direct.ts",
  settings: { timeoutMs: 120_000, limit: 10 },
} as CronContext;

describe("direct screen capture summary cron", () => {
  let directory: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    similarities.length = 0;
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

  function rows() {
    const db = openScreenCaptureDb();
    try {
      return db
        .prepare(
          "SELECT id, accepted, completed_at FROM screen_captures ORDER BY received_at, id",
        )
        .all() as {
        id: string;
        accepted: number | null;
        completed_at: string | null;
      }[];
    } finally {
      db.close();
    }
  }

  it("resizes and sends one agent the selected image paths", async () => {
    const ids = insert(2);
    await handler(ctx);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [groupName, , prompt] = vi.mocked(sendMessage).mock.calls[0];
    expect(groupName).toBe("logbook");
    for (const id of ids) {
      expect(prompt).toContain(`/workspace/.screen-captures/${id}.png`);
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
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      "magick",
      expect.arrayContaining(["-resize", "1280x1280>"]),
      expect.any(Function),
    );
    expect(rows().every((row) => row.accepted === 1 && row.completed_at)).toBe(
      true,
    );
  });

  it("limits accepted images and leaves the rest pending", async () => {
    const ids = insert(3);
    await handler({ ...ctx, settings: { timeoutMs: 120_000, limit: 2 } });

    expect(rows().find((row) => row.id === ids[2])).toMatchObject({
      accepted: null,
      completed_at: null,
    });
  });

  it("rejects images with at least 80 percent similarity", async () => {
    const ids = insert(2);
    similarities.push(0.8);
    await handler(ctx);

    const prompt = vi.mocked(sendMessage).mock.calls[0][2];
    expect(prompt).toContain(ids[0]);
    expect(prompt).not.toContain(ids[1]);
    expect(rows()).toEqual([
      expect.objectContaining({ id: ids[0], accepted: 1 }),
      expect.objectContaining({ id: ids[1], accepted: 0 }),
    ]);
  });

  it("leaves selected and rejected images pending when the agent fails", async () => {
    insert(2);
    similarities.push(0.9);
    vi.mocked(sendMessage).mockRejectedValue(new Error("agent failed"));

    await expect(handler(ctx)).rejects.toThrow("agent failed");
    expect(rows().every((row) => row.completed_at === null)).toBe(true);
  });

  it("rejects a missing group or invalid settings", async () => {
    await expect(handler({ ...ctx, groupName: undefined })).rejects.toThrow(
      "requires valid settings and groupName",
    );
    await expect(
      handler({ ...ctx, settings: { timeoutMs: 0, limit: 10 } }),
    ).rejects.toThrow("requires valid settings and groupName");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
