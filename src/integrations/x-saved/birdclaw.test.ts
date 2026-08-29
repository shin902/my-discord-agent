import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncBirdclawSavedCollections } from "./birdclaw.js";
import { resolveBirdclawDbPath } from "./store.js";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("BirdClaw subprocess boundary", () => {
  it("uses the normalized DB path and does not inherit daemon secrets", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-env-test-"));
    tempDirs.push(dir);
    const envPath = path.join(dir, "env.txt");
    const binary = path.join(dir, "birdclaw");
    writeFileSync(
      binary,
      `#!/bin/sh
printf '%s\\n' "$BIRDCLAW_DB_PATH" > '${envPath}'
env | sort >> '${envPath}'
printf '%s\\n' '{"fetched":1}'
`,
    );
    chmodSync(binary, 0o755);
    process.env.BIRDCLAW_BIN = binary;
    process.env.DISCORD_BOT_TOKEN = "must-not-cross-boundary";
    process.env.TEST_PROVIDER_API_KEY = "must-not-cross-boundary";

    const configuredPath = "~/birdclaw-test.sqlite";
    await syncBirdclawSavedCollections({
      mode: "xurl",
      limit: 1,
      maxPages: 1,
      birdclawDbPath: configuredPath,
    });

    const childEnv = readFileSync(envPath, "utf8");
    expect(childEnv.split("\n", 1)[0]).toBe(
      resolveBirdclawDbPath(configuredPath),
    );
    expect(childEnv).not.toContain("DISCORD_BOT_TOKEN");
    expect(childEnv).not.toContain("TEST_PROVIDER_API_KEY");
    expect(childEnv).toContain("BIRDCLAW_DISABLE_LIVE_WRITES=1");
  });
});
