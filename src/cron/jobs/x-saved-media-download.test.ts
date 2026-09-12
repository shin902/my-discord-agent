import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ingestXSavedItems,
  mergeXSavedMedia,
  openXSavedDb,
} from "../../integrations/x-saved/store.js";
import type { CronContext } from "../runner.js";
import handler from "./x-saved-media-download.js";

const image = "https://pbs.twimg.com/media/a.jpg?name=orig";
const video = "https://video.twimg.com/tweet_video/a.mp4";
const ctx = (limit = 20) => ({ settings: { limit } }) as CronContext;
const fx = (id: string, all: unknown[] = []) =>
  Response.json({
    code: 200,
    status: {
      id,
      type: "status",
      provider: "twitter",
      media: { all },
    },
  });

describe("one x-saved archive cron", () => {
  let root: string;
  let dbPath: string;
  let db: Database.Database;
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "archive-cron-"));
    dbPath = path.join(root, "x-saved.sqlite");
    vi.stubEnv("X_SAVED_DB_PATH", dbPath);
    db = openXSavedDb(dbPath);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(async () => {
    if (db.open) db.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  function seed(
    id: string,
    media?: Parameters<typeof ingestXSavedItems>[0][number]["media"],
  ) {
    ingestXSavedItems(
      [
        {
          tweetId: id,
          text: "old text",
          seenLiked: true,
          seenBookmarked: false,
          media,
        },
      ],
      { xSavedDb: db, now: "2026-01-01T00:00:00Z" },
    );
  }
  function media() {
    return db
      .prepare("SELECT * FROM x_media ORDER BY tweet_id, position")
      .all();
  }

  it("backfills a v2 text-only database with image and MP4 in one run, preserving Tweet and Agent state", async () => {
    seed("123");
    db.exec(
      "UPDATE x_item_state SET status='keep', note='important'; UPDATE x_items SET url='not-a-locator', author_handle=''; DROP INDEX idx_x_items_media_resolution; ALTER TABLE x_items DROP COLUMN media_resolved_at; ALTER TABLE x_items DROP COLUMN media_resolve_attempted_at; DROP TABLE x_media; PRAGMA user_version=2;",
    );
    const before = db.prepare("SELECT * FROM x_items").get() as object;
    const state = db.prepare("SELECT * FROM x_item_state").get();
    fetchMock
      .mockResolvedValueOnce(
        fx("123", [
          { type: "photo", url: image },
          { type: "video", url: video },
        ]),
      )
      .mockResolvedValueOnce(
        new Response("jpeg", { headers: { "content-type": "image/jpeg" } }),
      )
      .mockResolvedValueOnce(
        new Response("mp4", { headers: { "content-type": "video/mp4" } }),
      );
    await handler(ctx());
    expect(db.pragma("user_version", { simple: true })).toBe(4);
    expect(db.prepare("SELECT * FROM x_items").get()).toMatchObject({
      ...before,
      media_resolved_at: expect.any(String),
      media_resolve_attempted_at: expect.any(String),
    });
    expect(db.prepare("SELECT * FROM x_item_state").get()).toEqual(state);
    expect(media()).toEqual([
      expect.objectContaining({
        kind: "image",
        status: "done",
        local_path: "media/123/0.jpg",
      }),
      expect.objectContaining({
        kind: "video",
        status: "done",
        local_path: "media/123/1.mp4",
      }),
    ]);
    expect(await readFile(path.join(root, "media/123/1.mp4"), "utf8")).toBe(
      "mp4",
    );
    await handler(ctx());
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("does not use DOM hints as completeness, and never resets completed media on capture or re-resolution", async () => {
    seed("123", [{ kind: "image", position: 0, source_url: image }]);
    expect(db.prepare("SELECT media_resolved_at FROM x_items").get()).toEqual({
      media_resolved_at: null,
    });
    fetchMock
      .mockResolvedValueOnce(
        fx("123", [
          { type: "photo", url: image },
          { type: "video", url: video },
        ]),
      )
      .mockResolvedValueOnce(
        new Response("jpeg", { headers: { "content-type": "image/jpeg" } }),
      )
      .mockResolvedValueOnce(
        new Response("mp4", { headers: { "content-type": "video/mp4" } }),
      );
    await handler(ctx());
    const archived = media();
    seed("123");
    seed("123", []);
    seed("123", [
      {
        kind: "image",
        position: 0,
        source_url: image.replace("a.jpg", "different.jpg"),
      },
    ]);
    mergeXSavedMedia(
      db,
      "123",
      [
        {
          kind: "image",
          position: 0,
          source_url: image.replace("a.jpg", "different.jpg"),
        },
      ],
      new Date().toISOString(),
    );
    expect(media()).toEqual(archived);
    expect(await readFile(path.join(root, "media/123/0.jpg"), "utf8")).toBe(
      "jpeg",
    );
  });
  it("caches empty success even if no browser ever sends media", async () => {
    seed("123");
    fetchMock.mockResolvedValueOnce(fx("123"));
    await handler(ctx());
    await handler(ctx());
    expect(media()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      db.prepare("SELECT media_resolved_at FROM x_items").get(),
    ).toMatchObject({ media_resolved_at: expect.any(String) });
  });
  it("rotates failed resolutions behind untouched Tweets and retries after reopening", async () => {
    seed("123");
    seed("124");
    fetchMock
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce(fx("124"))
      .mockResolvedValueOnce(fx("123"));
    await handler(ctx(1));
    expect(
      db
        .prepare(
          "SELECT media_resolved_at, media_resolve_attempted_at FROM x_items WHERE tweet_id='123'",
        )
        .get(),
    ).toEqual({
      media_resolved_at: null,
      media_resolve_attempted_at: expect.any(String),
    });
    await handler(ctx(1));
    db.close();
    db = openXSavedDb(dbPath);
    await handler(ctx(1));
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://api.fxtwitter.com/2/status/123",
      "https://api.fxtwitter.com/2/status/124",
      "https://api.fxtwitter.com/2/status/123",
    ]);
  });
  it("continues download after an individual failure, retries next run, pending before failed", async () => {
    seed("123");
    mergeXSavedMedia(
      db,
      "123",
      [
        { kind: "image", position: 0, source_url: image },
        { kind: "video", position: 1, source_url: video },
      ],
      new Date().toISOString(),
    );
    fetchMock
      .mockRejectedValueOnce(new Error("image unavailable"))
      .mockResolvedValueOnce(
        new Response("video", { headers: { "content-type": "video/mp4" } }),
      )
      .mockResolvedValueOnce(
        new Response("image", { headers: { "content-type": "image/jpeg" } }),
      );
    await handler(ctx());
    expect(media()).toEqual([
      expect.objectContaining({
        status: "failed",
        last_error: expect.stringContaining("image unavailable"),
      }),
      expect.objectContaining({ status: "done" }),
    ]);
    await handler(ctx());
    expect(media()).toEqual([
      expect.objectContaining({ status: "done", last_error: null }),
      expect.objectContaining({ status: "done" }),
    ]);
  });
  it("bounds each phase independently and does not let a missing MP4 repeatedly block download candidates", async () => {
    seed("123");
    seed("124");
    fetchMock
      .mockResolvedValueOnce(fx("123", [{ type: "video" }]))
      .mockResolvedValueOnce(fx("124", [{ type: "photo", url: image }]))
      .mockResolvedValueOnce(
        new Response("image", { headers: { "content-type": "image/jpeg" } }),
      );
    await handler(ctx(1));
    expect(media()).toEqual([
      expect.objectContaining({
        kind: "video",
        status: "failed",
        source_url: null,
      }),
    ]);
    await handler(ctx(1));
    expect(media()).toEqual([
      expect.objectContaining({ status: "failed" }),
      expect.objectContaining({ status: "done" }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("does not remove omitted hints, and rolls back media plus successful resolution on DB error", () => {
    seed("123", [{ kind: "image", position: 0, source_url: image }]);
    seed("123", []);
    expect(media()).toHaveLength(1);
    db.exec(
      "CREATE TRIGGER reject_resolution BEFORE UPDATE OF media_resolved_at ON x_items BEGIN SELECT RAISE(ABORT, 'DB failure'); END;",
    );
    expect(() =>
      mergeXSavedMedia(
        db,
        "123",
        [{ kind: "video", position: 1, source_url: video }],
        new Date().toISOString(),
      ),
    ).toThrow("DB failure");
    expect(media()).toHaveLength(1);
    expect(db.prepare("SELECT media_resolved_at FROM x_items").get()).toEqual({
      media_resolved_at: null,
    });
    db.exec("DELETE FROM x_items;");
    expect(media()).toHaveLength(0);
  });
  it("propagates resolution DB failure rather than swallowing it as a provider failure", async () => {
    seed("123");
    db.exec(
      "CREATE TRIGGER reject_media BEFORE INSERT ON x_media BEGIN SELECT RAISE(ABORT, 'DB failure'); END;",
    );
    fetchMock.mockResolvedValueOnce(fx("123", [{ type: "photo", url: image }]));
    await expect(handler(ctx())).rejects.toThrow("DB failure");
    expect(db.prepare("SELECT media_resolved_at FROM x_items").get()).toEqual({
      media_resolved_at: null,
    });
  });
  it("downloads pending rows before failed ones within the same bound", async () => {
    seed("123");
    mergeXSavedMedia(
      db,
      "123",
      [
        { kind: "image", position: 0, source_url: image },
        { kind: "video", position: 1, source_url: video },
      ],
      new Date().toISOString(),
    );
    db.exec("UPDATE x_media SET status='failed' WHERE position=0");
    fetchMock.mockResolvedValueOnce(
      new Response("mp4", { headers: { "content-type": "video/mp4" } }),
    );
    await handler(ctx(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(video);
  });

  it("replaces pending source hints without keeping alt text from a different source", () => {
    seed("123", [
      { kind: "image", position: 0, source_url: image, alt_text: "old hint" },
    ]);
    const source = image.replace("a.jpg", "b.jpg");
    mergeXSavedMedia(
      db,
      "123",
      [{ kind: "image", position: 0, source_url: source }],
      new Date().toISOString(),
    );
    expect(media()).toEqual([
      expect.objectContaining({
        source_url: source,
        alt_text: null,
        status: "pending",
      }),
    ]);
  });

  it("rolls back a failed schema migration and propagates it out of cron", async () => {
    seed("123");
    db.exec(
      "DROP INDEX idx_x_items_media_resolution; ALTER TABLE x_items DROP COLUMN media_resolved_at; ALTER TABLE x_items DROP COLUMN media_resolve_attempted_at; DROP TABLE x_media; CREATE VIEW x_media AS SELECT tweet_id FROM x_items; PRAGMA user_version=2;",
    );
    await expect(handler(ctx())).rejects.toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect(db.prepare("PRAGMA table_info(x_items)").all()).not.toContainEqual(
      expect.objectContaining({ name: "media_resolved_at" }),
    );
    expect(db.prepare("SELECT text FROM x_items").get()).toEqual({
      text: "old text",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates download status DB failure", async () => {
    seed("123");
    mergeXSavedMedia(
      db,
      "123",
      [{ kind: "image", position: 0, source_url: image }],
      new Date().toISOString(),
    );
    db.exec(
      "CREATE TRIGGER reject_status BEFORE UPDATE ON x_media BEGIN SELECT RAISE(ABORT, 'DB failure'); END;",
    );
    fetchMock.mockResolvedValueOnce(
      new Response("image", { headers: { "content-type": "image/jpeg" } }),
    );
    await expect(handler(ctx())).rejects.toThrow("DB failure");
  });
  it.each([0, -1, 101, 1.5])("rejects invalid limit %s", async (limit) => {
    await expect(handler(ctx(limit))).rejects.toThrow("settings");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
