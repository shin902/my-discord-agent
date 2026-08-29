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
printf '%s\\n' '{"ok":true}'
`,
    );
    chmodSync(binary, 0o755);
    process.env.BIRDCLAW_BIN = binary;
    process.env.DISCORD_BOT_TOKEN = "must-not-cross-boundary";
    process.env.TEST_PROVIDER_API_KEY = "must-not-cross-boundary";
    process.env.HTTP_PROXY = "http://proxy.example.test:8080";
    process.env.HTTPS_PROXY = "https://proxy.example.test:8443";
    process.env.ALL_PROXY = "socks5://proxy.example.test:1080";
    process.env.NO_PROXY = "localhost,127.0.0.1";
    process.env.http_proxy = "http://lower-proxy.example.test:8080";
    process.env.https_proxy = "https://lower-proxy.example.test:8443";
    process.env.all_proxy = "socks5://lower-proxy.example.test:1080";
    process.env.no_proxy = "localhost";
    process.env.SSL_CERT_FILE = "/etc/ssl/custom-ca.pem";
    process.env.SSL_CERT_DIR = "/etc/ssl/custom-certs";
    process.env.NODE_EXTRA_CA_CERTS = "/etc/ssl/extra-ca.pem";

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
    expect(childEnv).toContain("HTTP_PROXY=http://proxy.example.test:8080");
    expect(childEnv).toContain("HTTPS_PROXY=https://proxy.example.test:8443");
    expect(childEnv).toContain("ALL_PROXY=socks5://proxy.example.test:1080");
    expect(childEnv).toContain("NO_PROXY=localhost,127.0.0.1");
    expect(childEnv).toContain(
      "http_proxy=http://lower-proxy.example.test:8080",
    );
    expect(childEnv).toContain(
      "https_proxy=https://lower-proxy.example.test:8443",
    );
    expect(childEnv).toContain(
      "all_proxy=socks5://lower-proxy.example.test:1080",
    );
    expect(childEnv).toContain("no_proxy=localhost");
    expect(childEnv).toContain("SSL_CERT_FILE=/etc/ssl/custom-ca.pem");
    expect(childEnv).toContain("SSL_CERT_DIR=/etc/ssl/custom-certs");
    expect(childEnv).toContain("NODE_EXTRA_CA_CERTS=/etc/ssl/extra-ca.pem");
    expect(childEnv).toContain("BIRDCLAW_DISABLE_LIVE_WRITES=1");
  });
});
