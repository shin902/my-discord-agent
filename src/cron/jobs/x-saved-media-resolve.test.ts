import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ingestXSavedItems,
  openXSavedDb,
  recordResolvedXSavedMedia,
  type XSavedItem,
} from "../../integrations/x-saved/store.js";
import { NonRetryableError } from "../../utils/error.js";
import { type CronContext, loadHandlerFn } from "../runner.js";
import download from "./x-saved-media-download.js";
import handler from "./x-saved-media-resolve.js";

function context(settings?: unknown): CronContext {
  return {
    id: "x-saved-media-resolve",
    schedule: "*/5 * * * *",
    enabled: false,
    handler: "jobs/x-saved-media-resolve.ts",
    settings,
    client: {} as never,
    appendInbox: vi.fn(),
  };
}
const photo = (name: string) => ({
  type: "photo",
  url: `https://pbs.twimg.com/media/${name}.jpg`,
});
const response = (id: string, all: object[] = []) =>
  Response.json({
    code: 200,
    status: { type: "status", provider: "twitter", id, media: { all } },
  });

describe("x-saved Tweet-ID media backfill", () => {
  let directory: string;
  let db: Database.Database;
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "x-saved-resolve-"));
    vi.stubEnv("X_SAVED_DB_PATH", path.join(directory, "x-saved.sqlite"));
    db = openXSavedDb();
    fetchMock
      .mockReset()
      .mockImplementation(async (url) =>
        response(String(url).split("/").at(-1) ?? ""),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(async () => {
    db.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  function seed(tweetId = "123", media?: XSavedItem["media"]) {
    const item = {
      tweetId,
      text: "Original saved text",
      seenLiked: true,
      seenBookmarked: false,
      media,
    };
    ingestXSavedItems([item], { xSavedDb: db, now: "2026-01-01T00:00:00Z" });
    return item;
  }
  const images = () =>
    db.prepare("SELECT * FROM x_media ORDER BY tweet_id, position, kind").all();
  const resolutions = () =>
    db.prepare("SELECT * FROM x_media_resolution ORDER BY tweet_id").all();

  it("backfills legacy text-only IDs without browser replay, author or stored URL; preserves item/state", async () => {
    seed();
    db.exec(
      "UPDATE x_items SET url = 'https://evil.example/not-a-locator'; UPDATE x_item_state SET status = 'keep', note = 'Keep this note'; DROP TABLE x_media_resolution; PRAGMA user_version = 3",
    );
    const before = db
      .prepare("SELECT * FROM x_items JOIN x_item_state USING (tweet_id)")
      .get();
    fetchMock.mockResolvedValueOnce(
      response("123", [
        photo("one"),
        { type: "video", url: "https://video.twimg.com/ignored.mp4" },
      ]),
    );
    expect(await loadHandlerFn("jobs/x-saved-media-resolve.ts")).toBe(handler);
    const ctx = context();
    await handler(ctx);
    expect(ctx.appendInbox).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.fxtwitter.com/2/status/123",
    );
    expect(db.pragma("user_version", { simple: true })).toBe(4);
    expect(
      db
        .prepare("SELECT * FROM x_items JOIN x_item_state USING (tweet_id)")
        .get(),
    ).toEqual(before);
    expect(images()).toEqual([
      expect.objectContaining({
        tweet_id: "123",
        kind: "image",
        position: 0,
        status: "pending",
        source_url: photo("one").url,
      }),
      expect.objectContaining({
        tweet_id: "123",
        kind: "video",
        position: 1,
        source_url: null,
        local_path: null,
      }),
    ]);
    await handler(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(
      new Response("image bytes", {
        headers: { "Content-Type": "image/jpeg" },
      }),
    );
    await download(context());
    expect(images()[0]).toMatchObject({
      status: "done",
      local_path: "media/123/0.jpg",
    });
  });

  it("resolves partial DOM media too, preserves matching completed files and rejects later DOM overrides", async () => {
    const item = seed("123", [
      {
        kind: "image",
        position: 0,
        source_url: "https://pbs.twimg.com/media/one?format=jpg&name=small",
        alt_text: "DOM alt",
      },
    ]);
    db.exec(
      "UPDATE x_media SET status = 'done', local_path = 'media/123/0.jpg'",
    );
    fetchMock.mockResolvedValueOnce(
      response("123", [photo("one"), photo("two")]),
    );
    await handler(context());
    expect(images()).toEqual([
      expect.objectContaining({
        position: 0,
        status: "done",
        local_path: "media/123/0.jpg",
        alt_text: "DOM alt",
      }),
      expect.objectContaining({
        position: 1,
        status: "pending",
        source_url: photo("two").url,
      }),
    ]);
    const before = images();
    ingestXSavedItems(
      [
        {
          ...item,
          seenBookmarked: true,
          media: [
            { kind: "image", position: 1, source_url: photo("wrong").url },
          ],
        },
      ],
      { xSavedDb: db },
    );
    expect(images()).toEqual(before);
    expect(
      db.prepare("SELECT seen_liked, seen_bookmarked FROM x_items").get(),
    ).toEqual({ seen_liked: 1, seen_bookmarked: 1 });
  });

  it("corrects a misplaced completed DOM image instead of treating the slot as already complete", async () => {
    seed("123", [
      {
        kind: "image",
        position: 0,
        source_url: photo("two").url,
        alt_text: "Wrong slot",
      },
    ]);
    db.exec(
      "UPDATE x_media SET status = 'done', local_path = 'media/123/0.jpg'",
    );
    fetchMock.mockResolvedValueOnce(
      response("123", [photo("one"), photo("two")]),
    );
    await handler(context());
    expect(images()).toEqual([
      expect.objectContaining({
        position: 0,
        source_url: photo("one").url,
        status: "pending",
        local_path: null,
        alt_text: null,
      }),
      expect.objectContaining({
        position: 1,
        source_url: photo("two").url,
        status: "pending",
      }),
    ]);
  });

  it("corrects mixed-media slot conflicts without duplicating DOM hints", async () => {
    seed("123", [
      { kind: "video", position: 0 },
      { kind: "image", position: 1, source_url: photo("one").url },
    ]);
    fetchMock.mockResolvedValueOnce(
      response("123", [photo("one"), { type: "video" }]),
    );
    await handler(context());
    expect(images()).toEqual([
      expect.objectContaining({
        position: 0,
        kind: "image",
        source_url: photo("one").url,
      }),
      expect.objectContaining({ position: 1, kind: "video", source_url: null }),
    ]);
  });

  it("records successful empty results so media-less Tweets do not monopolize every run", async () => {
    seed();
    await handler(context());
    await handler(context());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(resolutions()).toEqual([
      expect.objectContaining({ resolved_at: expect.any(String) }),
    ]);
    expect(images()).toEqual([]);
  });

  it("bounds work, rotates failures without starving untouched IDs and retries after reopen", async () => {
    seed("123");
    seed("124");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 429 }));
    await handler(context({ limit: 1 }));
    expect(resolutions()).toEqual([
      expect.objectContaining({ tweet_id: "123", resolved_at: null }),
    ]);
    await handler(context({ limit: 1 }));
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.fxtwitter.com/2/status/124",
    );
    db.close();
    db = openXSavedDb();
    await handler(context({ limit: 1 }));
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "https://api.fxtwitter.com/2/status/123",
    );
    expect(resolutions()).toHaveLength(2);
    expect(
      resolutions().every(
        (row) => (row as { resolved_at: string }).resolved_at,
      ),
    ).toBe(true);
  });

  it("continues after one failed lookup without marking it resolved or damaging ingest", async () => {
    seed("123");
    seed("124");
    fetchMock.mockResolvedValueOnce(response("999", [photo("one")]));
    await handler(context());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resolutions()).toEqual([
      expect.objectContaining({ tweet_id: "123", resolved_at: null }),
      expect.objectContaining({
        tweet_id: "124",
        resolved_at: expect.any(String),
      }),
    ]);
    expect(db.prepare("SELECT COUNT(*) n FROM x_items").get()).toEqual({
      n: 2,
    });
  });

  it("rolls back media and the success marker on SQL failure, then retries", async () => {
    seed();
    fetchMock.mockImplementation(async () =>
      response("123", [photo("one"), photo("two")]),
    );
    db.exec(
      "CREATE TRIGGER fail_media BEFORE INSERT ON x_media WHEN NEW.position = 1 BEGIN SELECT RAISE(ABORT, 'test rollback'); END",
    );
    await expect(handler(context())).rejects.toThrow("test rollback");
    expect(images()).toEqual([]);
    expect(resolutions()[0]).toMatchObject({ resolved_at: null });
    db.exec("DROP TRIGGER fail_media");
    await handler(context());
    expect(images()).toHaveLength(2);
    db.exec("DELETE FROM x_items");
    expect(images()).toEqual([]);
    expect(resolutions()).toEqual([]);
  });

  it("validates metadata before writing a resolution marker", () => {
    seed();
    expect(() =>
      recordResolvedXSavedMedia(db, "123", [
        { kind: "image", position: 0, source_url: "https://evil.example" },
      ]),
    ).toThrow();
    expect(resolutions()).toEqual([]);
    expect(images()).toEqual([]);
  });

  it("defaults to twenty bounded IDs", async () => {
    for (let n = 100; n < 122; n++) seed(String(n));
    await handler(context());
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });
  it.each([
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: "1" },
    { unexpected: true },
  ])("rejects settings before I/O: %j", async (settings) => {
    await expect(handler(context(settings))).rejects.toBeInstanceOf(
      NonRetryableError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
