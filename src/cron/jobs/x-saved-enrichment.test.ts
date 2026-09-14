import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseXSavedEnrichment } from "../../integrations/x-saved/enrichment.js";
import {
  ingestXSavedItems,
  openXSavedDb,
} from "../../integrations/x-saved/store.js";
import type { CronContext } from "../runner.js";
import handler from "./x-saved-media-download.js";

const author = {
  id: "42",
  screen_name: "writer",
  name: "Writer",
  avatar_url: "https://pbs.twimg.com/profile_images/avatar.jpg",
  url: "https://x.com/writer",
};
const status = (id: string) => ({
  id,
  type: "status",
  provider: "twitter",
  text: `Post ${id}`,
  url: `https://x.com/writer/status/${id}`,
  created_at: "2026-09-01T00:00:00Z",
  author,
  raw_text: { text: `Post ${id}`, facets: [] },
  media: { all: [] },
});
const response = (id: string) => ({
  code: 200,
  status: status(id),
  thread: null,
});
const ctx = (limit = 20) => ({ settings: { limit } }) as CronContext;

describe("x-saved FxTwitter context backfill", () => {
  let root: string;
  let db: Database.Database;
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "x-enrichment-"));
    vi.stubEnv("X_SAVED_DB_PATH", path.join(root, "x-saved.sqlite"));
    db = openXSavedDb();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(async () => {
    db.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  function seed(id: string, mediaResolved = true) {
    ingestXSavedItems(
      [
        {
          tweetId: id,
          text: "browser text",
          seenLiked: true,
          seenBookmarked: true,
        },
      ],
      { xSavedDb: db },
    );
    if (mediaResolved)
      db.prepare(
        "UPDATE x_items SET media_resolved_at = 'old' WHERE tweet_id = ?",
      ).run(id);
  }
  function row(id = "123") {
    return db
      .prepare("SELECT * FROM x_enrichment WHERE tweet_id = ?")
      .get(id) as
      | {
          document_json: string | null;
          resolved_at: string | null;
          attempted_at: string;
          last_error: string | null;
        }
      | undefined;
  }
  function document(id = "123") {
    return JSON.parse(row(id)?.document_json ?? "null");
  }

  it("enriches a fresh saved middle post with ordered self-thread, one quote level, full article and facets", async () => {
    seed("123", false);
    const article = {
      id: "900",
      title: "Full article",
      preview_text: "Preview",
      content: {
        blocks: [
          { text: "全文".repeat(70_000), type: "unstyled", entityRanges: [] },
        ],
        entityMap: [
          {
            key: "0",
            value: {
              type: "LINK",
              data: { url: "https://example.com/article" },
            },
          },
        ],
      },
      media_entities: [],
    };
    const facets = [
      {
        type: "url",
        indices: [0, 5],
        original: "https://t.co/short",
        replacement: "https://example.com/full",
        display: "example.com/full",
      },
    ];
    const focal = {
      ...status("123"),
      article,
      raw_text: { text: "link", facets },
      quote: {
        ...status("90"),
        author: { ...author, id: "43", screen_name: "quoted" },
        quote: status("80"),
      },
    };
    const next = {
      ...status("124"),
      article,
      raw_text: { text: "link", facets },
      quote: status("91"),
    };
    fetchMock
      .mockResolvedValueOnce(Response.json(response("123")))
      .mockResolvedValueOnce(
        Response.json({
          code: 200,
          status: focal,
          thread: [
            status("122"),
            focal,
            next,
            { ...status("125"), author: { ...author, id: "99" } },
          ],
        }),
      );
    await handler(ctx());
    const saved = document();
    expect(saved.status.author).toEqual(author);
    expect(saved.status.article).toEqual(article);
    expect(saved.status.raw_text.facets).toEqual(facets);
    expect(saved.status.external_urls).toEqual(["https://example.com/full"]);
    expect(saved.status.quote).toMatchObject({
      id: "90",
      text: "Post 90",
      author: { id: "43" },
    });
    expect(saved.status.quote).not.toHaveProperty("quote");
    expect(saved.thread.map((entry: { id: string }) => entry.id)).toEqual([
      "122",
      "123",
      "124",
    ]);
    expect(saved.thread[2]).toMatchObject({
      author,
      article,
      raw_text: { facets },
      quote: { id: "91" },
    });
    expect(row()).toMatchObject({
      resolved_at: expect.any(String),
      last_error: null,
    });
    await handler(ctx());
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.fxtwitter.com/2/status/123",
      "https://api.fxtwitter.com/2/thread/123",
    ]);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      credentials: "omit",
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });

  it("migrates v4 and backfills completed media without changing any existing saved state", async () => {
    seed("123");
    db.exec(`DROP TABLE x_enrichment; PRAGMA user_version=4;
      UPDATE x_item_state SET status='keep', note='important';
      INSERT INTO x_item_labels VALUES ('123', 'tag', 'retained');
      INSERT INTO x_meta VALUES ('initial_import_completed_at', 'old');
      INSERT INTO x_media (tweet_id,kind,position,source_url,local_path,status) VALUES ('123','image',0,'https://pbs.twimg.com/media/a.jpg','media/123/0.jpg','done');`);
    const tables = [
      "x_items",
      "x_item_state",
      "x_item_labels",
      "x_meta",
      "x_media",
    ];
    const before = tables.map((table) =>
      db.prepare(`SELECT * FROM ${table}`).all(),
    );
    fetchMock.mockResolvedValueOnce(Response.json(response("123")));
    await handler(ctx());
    expect(db.pragma("user_version", { simple: true })).toBe(5);
    expect(
      tables.map((table) => db.prepare(`SELECT * FROM ${table}`).all()),
    ).toEqual(before);
    expect(document().status.author).toEqual(author);
    expect(document().status).toMatchObject({
      quote: null,
      article: null,
      external_urls: [],
    });
    expect(document().thread).toHaveLength(1);
    const enriched = row();
    seed("123");
    await handler(ctx());
    expect(row()).toEqual(enriched);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    db.exec("DELETE FROM x_items");
    expect(row()).toBeUndefined();
  });

  it("bounds batches, repairs missing author snapshots, rotates failures and retries after reopening", async () => {
    seed("123");
    seed("124");
    seed("125");
    db.prepare("INSERT INTO x_enrichment VALUES (?, ?, ?, ?, NULL)").run(
      "125",
      JSON.stringify({ status: { id: "125" } }),
      "2020-01-01T00:00:00.000Z",
      "2020-01-01T00:00:00.000Z",
    );
    fetchMock
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValueOnce(Response.json(response("124")))
      .mockResolvedValueOnce(Response.json(response("125")))
      .mockResolvedValueOnce(Response.json(response("123")));
    await handler(ctx(1));
    expect(row()).toMatchObject({
      document_json: null,
      resolved_at: null,
      attempted_at: expect.any(String),
      last_error: expect.stringContaining("temporary"),
    });
    expect(row("124")).toBeUndefined();
    await handler(ctx(1));
    await handler(ctx(1));
    expect(document("125").status.author.id).toBe("42");
    db.close();
    db = openXSavedDb();
    await handler(ctx(1));
    expect(row()).toMatchObject({
      resolved_at: expect.any(String),
      last_error: null,
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(
      ["123", "124", "125", "123"].map(
        (id) => `https://api.fxtwitter.com/2/thread/${id}`,
      ),
    );
  });

  it("continues the same batch after a malformed/missing author response and retries it", async () => {
    seed("123");
    seed("124");
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          ...response("123"),
          status: { ...status("123"), author: undefined },
        }),
      )
      .mockResolvedValueOnce(Response.json(response("124")))
      .mockResolvedValueOnce(Response.json(response("123")));
    await handler(ctx());
    expect(row()?.resolved_at).toBeNull();
    expect(row("124")?.resolved_at).toEqual(expect.any(String));
    await handler(ctx());
    expect(row()?.resolved_at).toEqual(expect.any(String));
  });

  it("does not mark successful when persistence fails", async () => {
    seed("123");
    db.exec(
      "CREATE TRIGGER reject_enrichment BEFORE UPDATE OF document_json ON x_enrichment BEGIN SELECT RAISE(ABORT, 'DB failure'); END;",
    );
    fetchMock.mockResolvedValueOnce(Response.json(response("123")));
    await expect(handler(ctx())).rejects.toThrow("DB failure");
    expect(row()).toMatchObject({
      document_json: null,
      resolved_at: null,
      last_error: null,
    });
  });

  it("preserves tombstone gaps and quotes without crawling unavailable posts", () => {
    const tombstone = {
      type: "tombstone",
      provider: "twitter",
      id: "122",
      reason: "deleted",
      message: "Deleted",
    };
    const parsed = parseXSavedEnrichment(
      {
        code: 200,
        status: { ...status("123"), quote: tombstone },
        thread: [status("121"), tombstone, status("124")],
      },
      "123",
    );
    expect(parsed.status.quote).toEqual(tombstone);
    expect(parsed.thread.map((entry) => entry.id)).toEqual([
      "121",
      "122",
      "123",
      "124",
    ]);
  });

  it.each([
    { ...response("124") },
    { ...response("123"), code: 404 },
    { ...response("123"), thread: undefined },
    {
      ...response("123"),
      status: {
        ...status("123"),
        article: { id: "900", title: "Preview only" },
      },
    },
  ])("rejects incomplete or mismatched responses", (raw) => {
    expect(() => parseXSavedEnrichment(raw, "123")).toThrow();
  });
});
