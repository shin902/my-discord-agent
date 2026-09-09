import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadXSavedImage } from "../../integrations/x-saved/image-download.js";
import {
  ingestXSavedItems,
  openXSavedDb,
} from "../../integrations/x-saved/store.js";
import { NonRetryableError } from "../../utils/error.js";
import { type CronContext, loadHandlerFn } from "../runner.js";
import handler from "./x-saved-media-download.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6+AAAAABJRU5ErkJggg==",
  "base64",
);
function response() {
  return new Response(png, { headers: { "Content-Type": "image/png" } });
}
function context(settings?: unknown): CronContext {
  return {
    id: "x-saved-media-download",
    schedule: "*/5 * * * *",
    enabled: false,
    handler: "jobs/x-saved-media-download.ts",
    settings,
    client: {} as never,
    appendInbox: vi.fn(),
  };
}

describe("x-saved image-only host cron", () => {
  let directory: string;
  let db: Database.Database;
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "x-saved-media-"));
    const dbPath = path.join(directory, "x-saved.sqlite");
    db = openXSavedDb(dbPath);
    vi.stubEnv("X_SAVED_DB_PATH", dbPath);
    fetchMock.mockReset().mockImplementation(async () => response());
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
  function seed(
    id = "123",
    source = "https://pbs.twimg.com/media/a?format=jpg&name=small",
  ) {
    ingestXSavedItems(
      [
        {
          tweetId: id,
          text: "media",
          seenLiked: true,
          seenBookmarked: false,
          media: [
            { kind: "image", position: 0, source_url: source },
            { kind: "video", position: 1 },
          ],
        },
      ],
      { xSavedDb: db },
    );
  }
  function images() {
    return db
      .prepare(
        "SELECT tweet_id, status, local_path, last_error FROM x_media WHERE kind = 'image' ORDER BY tweet_id",
      )
      .all();
  }

  it("loads through the existing registry, prefers orig, stores atomic relative files and ignores video/done rows", async () => {
    seed();
    expect(await loadHandlerFn("jobs/x-saved-media-download.ts")).toBe(handler);
    const ctx = context();
    await handler(ctx);
    expect(ctx.appendInbox).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://pbs.twimg.com/media/a?format=jpg&name=orig",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        credentials: "omit",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty("headers");
    expect(images()).toEqual([
      {
        tweet_id: "123",
        status: "done",
        local_path: "media/123/0.png",
        last_error: null,
      },
    ]);
    expect(await readFile(path.join(directory, "media/123/0.png"))).toEqual(
      png,
    );
    expect(await readdir(path.join(directory, "media/123"))).toEqual(["0.png"]);
    expect(
      db
        .prepare(
          "SELECT status, source_url, local_path FROM x_media WHERE kind = 'video'",
        )
        .get(),
    ).toEqual({ status: "pending", source_url: null, local_path: null });
    await handler(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back only to the original validated source URL when orig fails", async () => {
    seed();
    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    await handler(context());
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://pbs.twimg.com/media/a?format=jpg&name=orig",
      "https://pbs.twimg.com/media/a?format=jpg&name=small",
    ]);
    expect(images()[0]).toMatchObject({ status: "done" });
  });

  it("marks individual failures, continues the batch and retries failed images on the next cron", async () => {
    seed("1");
    seed("2");
    fetchMock
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"));
    await expect(handler(context())).resolves.toBeUndefined();
    expect(images()).toEqual([
      {
        tweet_id: "1",
        status: "failed",
        local_path: null,
        last_error: "offline",
      },
      {
        tweet_id: "2",
        status: "done",
        local_path: "media/2/0.png",
        last_error: null,
      },
    ]);
    await handler(context());
    expect(images()[0]).toMatchObject({ status: "done", last_error: null });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("bounds selection and gives pending images priority over failed images", async () => {
    seed("1");
    seed("2");
    seed("3");
    db.exec(
      "UPDATE x_media SET status = 'failed' WHERE tweet_id = '1' AND kind = 'image'",
    );
    await handler(context({ limit: 1 }));
    expect(images()).toEqual([
      { tweet_id: "1", status: "failed", local_path: null, last_error: null },
      {
        tweet_id: "2",
        status: "done",
        local_path: "media/2/0.png",
        last_error: null,
      },
      { tweet_id: "3", status: "pending", local_path: null, last_error: null },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await handler(context());
    expect(images()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tweet_id: "1", status: "done" }),
      ]),
    );
  });

  it("defaults to only 20 images per run", async () => {
    for (let id = 1; id <= 21; id++) seed(String(id));
    await handler(context());
    expect(fetchMock).toHaveBeenCalledTimes(20);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM x_media WHERE kind = 'image' AND status = 'pending'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it.each([
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: "20" },
    { retry_count: 1 },
  ])("rejects invalid settings: %j", async (settings) => {
    await expect(handler(context(settings))).rejects.toBeInstanceOf(
      NonRetryableError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revalidates stored URLs and path identifiers before any fetch or write", async () => {
    seed("1");
    seed("2");
    seed("3");
    db.exec(
      "UPDATE x_media SET source_url = 'http://127.0.0.1/private' WHERE tweet_id = '1' AND kind = 'image'; UPDATE x_media SET position = -1 WHERE tweet_id = '2' AND kind = 'image'",
    );
    await handler(context());
    expect(images()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tweet_id: "1", status: "failed" }),
        expect.objectContaining({ tweet_id: "2", status: "failed" }),
        expect.objectContaining({ tweet_id: "3", status: "done" }),
      ]),
    );
    await expect(
      downloadXSavedImage(directory, {
        tweet_id: "../escape",
        position: 0,
        source_url: "https://pbs.twimg.com/media/a",
      }),
    ).rejects.toThrow("path identifiers");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not leave partial files on a truncated response or rename failure", async () => {
    seed();
    fetchMock.mockImplementation(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(png.subarray(0, 8));
              controller.error(new Error("truncated"));
            },
          }),
          { headers: { "Content-Type": "image/png" } },
        ),
    );
    await handler(context());
    expect(images()[0]).toMatchObject({ status: "failed", local_path: null });
    expect(existsSync(path.join(directory, "media/123/0.png"))).toBe(false);
    fetchMock.mockImplementation(async () => response());
    await mkdir(path.join(directory, "media/123/0.png"), { recursive: true });
    await handler(context()); // rename cannot replace a directory
    expect(images()[0]).toMatchObject({ status: "failed", local_path: null });
    expect(await readdir(path.join(directory, "media/123"))).toEqual(["0.png"]); // no .tmp
  });

  it("refuses symlinked media directories rather than writing outside the mount", async () => {
    seed();
    const outside = path.join(directory, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(directory, "media"));
    await handler(context());
    expect(images()[0]).toMatchObject({ status: "failed", local_path: null });
    expect(await readdir(outside)).toEqual([]);
  });

  it.each([
    () =>
      new Response("redirect", {
        status: 302,
        headers: { Location: "http://127.0.0.1/private" },
      }),
    () => new Response("html", { headers: { "Content-Type": "text/html" } }),
    () => new Response("html", { headers: { "Content-Type": "constructor" } }),
    () =>
      new Response(png, {
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(10 * 1024 * 1024 + 1),
        },
      }),
    () =>
      new Response(new Uint8Array(10 * 1024 * 1024 + 1), {
        headers: { "Content-Type": "image/png" },
      }),
  ])("fails closed on redirects, unsupported types and oversized responses", async (makeResponse) => {
    seed();
    fetchMock.mockImplementation(async () => makeResponse());
    await handler(context());
    expect(images()[0]).toMatchObject({ status: "failed", local_path: null });
    expect(
      fetchMock.mock.calls.every(
        ([url, init]) =>
          String(url).startsWith("https://pbs.twimg.com/media/") &&
          init?.redirect === "error",
      ),
    ).toBe(true);
    expect(existsSync(path.join(directory, "media/123/0.png"))).toBe(false);
  });

  it("does not overwrite concurrent enrichment with an older download outcome", async () => {
    seed();
    fetchMock.mockImplementationOnce(async () => {
      db.exec(
        "UPDATE x_media SET source_url = 'https://pbs.twimg.com/media/new' WHERE kind = 'image'",
      );
      return response();
    });
    await handler(context());
    expect(images()[0]).toMatchObject({ status: "pending", local_path: null });
    await handler(context());
    expect(images()[0]).toMatchObject({ status: "done" });
  });

  it("propagates schema/open/update failures as whole-job failures", async () => {
    seed();
    db.exec(
      "CREATE TRIGGER fail_update BEFORE UPDATE ON x_media BEGIN SELECT RAISE(ABORT, 'database broken'); END",
    );
    await expect(handler(context())).rejects.toThrow("database broken");
    db.exec("DROP TRIGGER fail_update; PRAGMA user_version = 999");
    await expect(handler(context())).rejects.toThrow("newer than supported");
    const invalid = path.join(directory, "not-sqlite");
    await writeFile(invalid, "not sqlite");
    vi.stubEnv("X_SAVED_DB_PATH", invalid);
    await expect(handler(context())).rejects.toThrow();
    vi.stubEnv("X_SAVED_DB_PATH", directory);
    await expect(handler(context())).rejects.toThrow();
  });
});
