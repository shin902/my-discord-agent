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

const validResponse = JSON.stringify({
  ok: true,
  source: "xurl",
  kind: "likes",
  accountId: "acct_primary",
  count: 1,
  payload: {
    data: [
      {
        id: "123456789012345678",
        text: "saved post",
        author_id: "author-1",
        created_at: "2026-09-03T00:00:00.000Z",
        entities: {
          urls: [
            {
              url: "https://t.co/article",
              expanded_url: "https://example.com/article",
            },
            {
              url: "https://t.co/post",
              expanded_url: "https://x.com/example/status/1",
            },
          ],
        },
      },
    ],
    includes: {
      users: [{ id: "author-1", username: "author" }],
    },
    meta: { result_count: 1 },
  },
});

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
printf '%s\\n' '${validResponse}'
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

  it("extracts tweet metadata from the current HTTP response payload", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-response-test-"));
    tempDirs.push(dir);
    const binary = path.join(dir, "birdclaw");
    writeFileSync(
      binary,
      `#!/bin/sh
printf '%s\\n' '${validResponse}'
`,
    );
    chmodSync(binary, 0o755);
    process.env.BIRDCLAW_BIN = binary;

    const result = await syncBirdclawSavedCollections({
      mode: "xurl",
      limit: 100,
      maxPages: 3,
    });

    expect(result.bookmarks.items).toEqual([
      expect.objectContaining({
        tweetId: "123456789012345678",
        text: "saved post",
        authorHandle: "author",
        tweetCreatedAt: "2026-09-03T00:00:00.000Z",
        externalUrls: ["https://example.com/article"],
        seenLiked: false,
        seenBookmarked: true,
      }),
    ]);
    expect(result.likes.items[0]).toEqual(
      expect.objectContaining({
        tweetId: "123456789012345678",
        seenLiked: true,
        seenBookmarked: false,
      }),
    );
  });

  it.each([
    ["empty output", "", "empty JSON output"],
    ["invalid JSON", "not-json", "invalid JSON"],
    ["non-object JSON", "[]", "invalid JSON envelope"],
  ])("rejects %s without returning the raw payload", async (_label, output, expectedError) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-output-test-"));
    tempDirs.push(dir);
    const binary = path.join(dir, "birdclaw");
    writeFileSync(
      binary,
      `#!/bin/sh
printf '%s' ${JSON.stringify(output)}
`,
    );
    chmodSync(binary, 0o755);
    process.env.BIRDCLAW_BIN = binary;

    const result = await syncBirdclawSavedCollections({
      mode: "xurl",
      limit: 1,
      maxPages: 1,
    });

    for (const collection of [result.bookmarks, result.likes]) {
      expect(collection.ok).toBe(false);
      expect(collection.error).toContain(expectedError);
      expect(collection).not.toHaveProperty("output");
    }
    if (output && output !== "[]") {
      expect(JSON.stringify(result)).not.toContain(output);
    }
  });
});
