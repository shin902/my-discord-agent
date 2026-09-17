import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openXSavedDb } from "../../integrations/x-saved/store.js";
import type { CronContext } from "../runner.js";
import handler from "./x-saved-classify.js";

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: vi.fn((_file, _args, _options, callback) => {
    callback(null, { stdout: '{"processed":1,"failed":0}', stderr: "" });
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("x-saved PixAI host classification", () => {
  it("runs offline classification checks without downloading a model", () => {
    expect(
      execFileSync(
        "python3",
        ["-m", "unittest", "scripts/test_x_saved_tagger.py"],
        {
          encoding: "utf8",
        },
      ),
    ).toBe("");
  });

  it.each([
    "python",
    "cache",
  ])("rejects the removed %s setting", async (key) => {
    await expect(
      handler({
        settings: {
          aliases: "config/x-saved-aliases.json",
          [key]: "arbitrary/path",
        },
      } as CronContext),
    ).rejects.toThrow("Invalid");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("validates settings before spawning and uses fixed host paths without a shell", async () => {
    await expect(
      handler({ settings: { limit: 0 } } as CronContext),
    ).rejects.toThrow("Invalid");
    expect(execFile).not.toHaveBeenCalled();
    const dir = await mkdtemp(path.join(os.tmpdir(), "x-classify-"));
    vi.stubEnv("X_SAVED_DB_PATH", path.join(dir, "archive.sqlite"));
    try {
      await handler({
        settings: {
          aliases: "config/x-saved-aliases.json",
        },
      } as CronContext);
      expect(execFile).toHaveBeenCalledWith(
        path.join(
          os.homedir(),
          ".local/share/my-discord-agent/x-saved-tagger/venv/bin/python",
        ),
        expect.arrayContaining([
          path.resolve("scripts/x-saved-tagger.py"),
          "--db",
          path.join(dir, "archive.sqlite"),
          "--cache",
          path.join(
            os.homedir(),
            ".local/share/my-discord-agent/x-saved-tagger/cache",
          ),
          "--device",
          "cpu",
          "--limit",
          "20",
          "--thresholds",
          "{}",
        ]),
        expect.objectContaining({ timeout: 1_800_000, killSignal: "SIGKILL" }),
        expect.any(Function),
      );
      const db = openXSavedDb();
      expect(db.pragma("user_version", { simple: true })).toBe(5);
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
