import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { runXSavedSync } from "./sync.js";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

const response = JSON.stringify({
  ok: true,
  source: "xurl",
  payload: {
    data: [
      {
        id: "123456789012345678",
        text: "from HTTP response",
        author_id: "author-1",
        created_at: "2026-09-03T00:00:00.000Z",
        entities: {
          urls: [{ expanded_url: "https://example.com/article" }],
        },
      },
    ],
    includes: {
      users: [{ id: "author-1", username: "author" }],
    },
  },
});

afterEach(() => {
  process.env = { ...originalEnv };
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("x-saved sync", () => {
  it("ingests tweet metadata from successful BirdClaw HTTP responses", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "x-saved-sync-test-"));
    tempDirs.push(dir);
    const binary = path.join(dir, "birdclaw");
    const xSavedDbPath = path.join(dir, "x-saved", "x-saved.sqlite");
    const backupPath = path.join(dir, "backups");
    writeFileSync(
      binary,
      `#!/bin/sh
printf '%s\\n' '${response}'
`,
    );
    chmodSync(binary, 0o755);
    process.env.BIRDCLAW_BIN = binary;
    process.env.BIRDCLAW_DB_PATH = path.join(dir, "missing-birdclaw.sqlite");

    const result = await runXSavedSync({
      mode: "xurl",
      limit: 100,
      maxPages: 3,
      xSavedDbPath,
      backupPath,
    });

    expect(result.status).toBe("success");
    expect(result.newItems).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.backupPath).toContain(path.join("backups", "x-saved-"));
    expect(readFileSync(result.backupPath as string).length).toBeGreaterThan(0);

    const db = new Database(xSavedDbPath, { readonly: true });
    expect(
      db
        .prepare(
          `SELECT tweet_id, text, author_handle, url, tweet_created_at,
                  external_urls_json, seen_liked, seen_bookmarked
           FROM x_items`,
        )
        .get(),
    ).toEqual({
      tweet_id: "123456789012345678",
      text: "from HTTP response",
      author_handle: "author",
      url: "https://x.com/author/status/123456789012345678",
      tweet_created_at: "2026-09-03T00:00:00.000Z",
      external_urls_json: '["https://example.com/article"]',
      seen_liked: 1,
      seen_bookmarked: 1,
    });
    db.close();
  });
});
