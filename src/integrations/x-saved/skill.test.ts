import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestXSavedItems, openXSavedDb } from "./store.js";

const script = path.resolve("templates/SKILLS/x-saved/scripts/x-saved.py");
let directory: string;
let dbPath: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "x-saved-skill-"));
  dbPath = path.join(directory, "x-saved.sqlite");
  ingestXSavedItems(
    [
      {
        tweetId: "123",
        text: "Diagram",
        seenLiked: true,
        seenBookmarked: false,
        media: [
          {
            kind: "image",
            position: 0,
            source_url: "https://pbs.twimg.com/media/a",
          },
          { kind: "video", position: 1 },
        ],
      },
      {
        tweetId: "456",
        text: "Text only",
        seenLiked: false,
        seenBookmarked: true,
      },
    ],
    { xSavedDbPath: dbPath },
  );
  const db = openXSavedDb(dbPath);
  db.exec(
    "UPDATE x_media SET status = 'done', local_path = 'media/123/0.jpg' WHERE kind = 'image'",
  );
  db.close();
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function run(...args: string[]) {
  return JSON.parse(
    execFileSync("python3", [script, "--db", dbPath, ...args], {
      encoding: "utf8",
    }),
  );
}

describe("x-saved skill media visibility", () => {
  it.each([
    ["show", "123"],
    ["pending"],
    ["recent"],
    ["search", "Diagram"],
  ])("exposes kinds, readable image paths and undownloaded videos via %j", (...args) => {
    const result = run(...args);
    const item =
      result.items?.find(
        (entry: { tweet_id: string }) => entry.tweet_id === "123",
      ) ?? result;
    expect(item.media).toEqual([
      expect.objectContaining({
        kind: "image",
        status: "done",
        local_path: "media/123/0.jpg",
        path: "/x-saved/media/123/0.jpg",
      }),
      expect.objectContaining({
        kind: "video",
        status: "pending",
        local_path: null,
        path: null,
      }),
    ]);
  });

  it("keeps text-only output and state commands working", () => {
    expect(run("show", "456")).toMatchObject({
      tweet_id: "456",
      text: "Text only",
      seen_bookmarked: true,
      media: [],
    });
    run("mark", "123", "keep");
    run("note", "123", "useful");
    expect(run("show", "123")).toMatchObject({
      status: "keep",
      note: "useful",
    });
    expect(run("status")).toMatchObject({ total: 2, pending: 1 });
  });

  it("handles a v2 installation before the host migrates it", () => {
    const db = openXSavedDb(dbPath);
    db.exec("DROP TABLE x_media; PRAGMA user_version = 2");
    db.close();
    expect(run("show", "123")).toMatchObject({ tweet_id: "123", media: [] });
  });

  it("does not render failed or unsafe local paths as readable images", () => {
    const db = openXSavedDb(dbPath);
    try {
      db.exec(
        "UPDATE x_media SET local_path = '../../secret' WHERE kind = 'image'",
      );
      expect(run("show", "123").media[0].path).toBeNull();
      db.exec(
        "UPDATE x_media SET status = 'failed', local_path = 'media/123/0.jpg' WHERE kind = 'image'",
      );
      expect(run("show", "123").media[0].path).toBeNull();
    } finally {
      db.close();
    }
  });
});
