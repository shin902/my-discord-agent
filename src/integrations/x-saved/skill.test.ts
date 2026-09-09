import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestXSavedItems, openXSavedDb } from "./store.js";

const script = path.resolve("templates/SKILLS/x-saved/scripts/x-saved.py");
describe("x-saved Skill archive visibility", () => {
  let directory: string;
  let dbPath: string;
  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "archive-skill-"));
    dbPath = path.join(directory, "saved.sqlite");
    ingestXSavedItems(
      [
        {
          tweetId: "123",
          text: "diagram",
          seenLiked: true,
          seenBookmarked: false,
        },
      ],
      { xSavedDbPath: dbPath },
    );
    const db = openXSavedDb(dbPath);
    db.exec(`INSERT INTO x_media (tweet_id,kind,position,status,local_path) VALUES
      ('123','image',0,'done','media/123/0.jpg'),
      ('123','video',1,'done','media/123/1.mp4'),
      ('123','image',2,'failed',NULL);`);
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
  it.each([
    ["pending"],
    ["recent"],
    ["search", "diagram"],
    ["show", "123"],
  ])("exposes image and MP4 paths for %j", (...args) => {
    const result = run(...args);
    const item = result.items?.[0] ?? result;
    expect(item.media).toEqual([
      expect.objectContaining({
        kind: "image",
        status: "done",
        path: "/x-saved/media/123/0.jpg",
      }),
      expect.objectContaining({
        kind: "video",
        status: "done",
        path: "/x-saved/media/123/1.mp4",
      }),
      expect.objectContaining({ kind: "image", status: "failed", path: null }),
    ]);
  });
  it("remains usable before the schema migration and preserves mark/note", () => {
    const db = openXSavedDb(dbPath);
    db.exec("DROP TABLE x_media");
    db.close();
    expect(run("show", "123").media).toEqual([]);
    run("mark", "123", "keep");
    run("note", "123", "useful");
    expect(run("show", "123")).toMatchObject({
      status: "keep",
      note: "useful",
    });
  });
  it.each([
    "/etc/passwd",
    "../../secret",
    "media/123/../0.jpg",
    "media/124/0.jpg",
    "media/123/0.mp4",
  ])("does not expose unsafe/mismatched image path %s", (unsafe) => {
    const db = openXSavedDb(dbPath);
    db.prepare(
      "UPDATE x_media SET local_path=? WHERE kind='image' AND position=0",
    ).run(unsafe);
    db.close();
    expect(run("show", "123").media[0].path).toBeNull();
  });
});
