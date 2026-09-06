import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const originalBotsPath = process.env.BOTS_PATH;
const tempDir = mkdtempSync(path.join(os.tmpdir(), "my-discord-agent-bots-"));
const botsPath = path.join(tempDir, "custom-bots.json");
process.env.BOTS_PATH = botsPath;

const { BOTS_PATH, loadRawBots } = await import("./config.js");

afterAll(() => {
  rmSync(tempDir, { recursive: true });
  if (originalBotsPath === undefined) delete process.env.BOTS_PATH;
  else process.env.BOTS_PATH = originalBotsPath;
});

describe("BOTS_PATH", () => {
  it("loads the Bot registry from the overridden path", async () => {
    writeFileSync(botsPath, '{"coding":{"group":"main"}}', "utf8");

    expect(BOTS_PATH).toBe(botsPath);
    expect(JSON.parse(readFileSync(botsPath, "utf8"))).toEqual({
      coding: { group: "main" },
    });
    await expect(loadRawBots()).resolves.toEqual({
      coding: { group: "main" },
    });
  });

  it("treats a missing registry as empty", async () => {
    rmSync(botsPath);

    await expect(loadRawBots()).resolves.toEqual({});
  });
});
