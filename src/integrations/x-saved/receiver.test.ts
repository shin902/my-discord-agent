import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import contractCases from "./browser-items.fixture.json" with { type: "json" };
import mediaCases from "./media.fixture.json" with { type: "json" };
import { MAX_BODY_BYTES, startXSavedReceiver } from "./receiver.js";
import { ingestXSavedItems, openXSavedDb } from "./store.js";

const item = {
  tweet_id: "123",
  text: "Saved post",
  author: "@alice",
  url: "https://x.com/alice/status/123",
  created_at: "2026-01-01T00:00:00.000Z",
  kind: "like",
};

describe("x-saved receiver", () => {
  let directory: string;
  let dbPath: string;
  let server: Server;
  let endpoint: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "x-saved-receiver-"));
    dbPath = path.join(directory, "saved.sqlite");
    server = await startXSavedReceiver({ port: 0, xSavedDbPath: dbPath });
    const address = server.address() as AddressInfo;
    expect(address.address).toBe("127.0.0.1");
    endpoint = `http://127.0.0.1:${address.port}/v1/x-saved/items`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  function post(payload: unknown) {
    return fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  // Mirrored in x-saved-extension/tests: storage admission and receiver agree.
  it.each(contractCases)("$name: matches extension validation", async ({
    item: capture,
    valid,
  }) => {
    const response = await post({ items: [capture] });
    expect(response.status).toBe(valid ? 200 : 400);
    const db = openXSavedDb(dbPath);
    try {
      expect(db.prepare("SELECT * FROM x_items").all()).toHaveLength(
        valid ? 1 : 0,
      );
      expect(db.prepare("SELECT * FROM x_item_state").all()).toHaveLength(
        valid ? 1 : 0,
      );
    } finally {
      db.close();
    }
  });

  it.each(
    mediaCases,
  )("$name: matches extension media validation before DB access", async ({
    media,
    valid,
  }) => {
    const capture = { ...item, ...(media === undefined ? {} : { media }) };
    const response = await post({ items: [item, capture] });
    expect(response.status).toBe(valid ? 200 : 400);
    if (!valid) {
      expect(existsSync(dbPath)).toBe(false);
      return;
    }
    const db = openXSavedDb(dbPath);
    try {
      expect(db.prepare("SELECT * FROM x_media").all()).toHaveLength(
        Array.isArray(media) ? media.length : 0,
      );
    } finally {
      db.close();
    }
  });

  it("enriches text-only items idempotently and commits media before ACK without downloading", async () => {
    await post({ items: [item] });
    const db = openXSavedDb(dbPath);
    try {
      const first = db.prepare("SELECT first_seen_at FROM x_items").get();
      db.prepare(
        "UPDATE x_item_state SET status = 'keep', note = 'preserve'",
      ).run();
      const media = [
        {
          kind: "image",
          position: 0,
          source_url: "https://pbs.twimg.com/media/a?format=jpg&name=small",
          alt_text: "Diagram",
        },
        { kind: "video", position: 1 },
      ];
      for (let i = 0; i < 2; i++) {
        const response = await post({
          items: [{ ...item, kind: "bookmark", media }],
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ accepted: ["bookmark:123"] });
        expect(
          db
            .prepare(
              "SELECT kind, source_url, status FROM x_media ORDER BY position",
            )
            .all(),
        ).toEqual([
          { kind: "image", source_url: media[0].source_url, status: "pending" },
          { kind: "video", source_url: null, status: "pending" },
        ]);
      }
      expect(existsSync(path.join(directory, "media"))).toBe(false);
      db.exec(
        "UPDATE x_media SET status = 'done', local_path = 'media/123/0.jpg' WHERE kind = 'image'",
      );
      await post({ items: [item, { ...item, media: [] }, { ...item, media }] });
      expect(db.prepare("SELECT * FROM x_media").all()).toHaveLength(2);
      expect(
        db
          .prepare(
            "SELECT status, local_path FROM x_media WHERE kind = 'image'",
          )
          .get(),
      ).toEqual({ status: "done", local_path: "media/123/0.jpg" });
      expect(db.prepare("SELECT status, note FROM x_item_state").get()).toEqual(
        { status: "keep", note: "preserve" },
      );
      expect(db.prepare("SELECT first_seen_at FROM x_items").get()).toEqual(
        first,
      );
      expect(
        db.prepare("SELECT seen_liked, seen_bookmarked FROM x_items").get(),
      ).toEqual({ seen_liked: 1, seen_bookmarked: 1 });
    } finally {
      db.close();
    }
  });

  it("rolls back items, state and earlier media when a media insert fails; never ACKs", async () => {
    const db = openXSavedDb(dbPath);
    try {
      db.exec(
        "CREATE TRIGGER fail_media BEFORE INSERT ON x_media WHEN NEW.kind = 'video' BEGIN SELECT RAISE(ABORT, 'failed'); END",
      );
      const response = await post({
        items: [
          {
            ...item,
            media: [
              {
                kind: "image",
                position: 0,
                source_url: "https://pbs.twimg.com/media/a",
              },
              { kind: "video", position: 1 },
            ],
          },
        ],
      });
      expect(response.status).toBe(500);
      expect(await response.json()).not.toHaveProperty("accepted");
      for (const table of ["x_items", "x_item_state", "x_media"])
        expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("ACKs committed items, merges flags, and preserves state and omitted metadata on retries", async () => {
    const db = openXSavedDb(dbPath);
    try {
      ingestXSavedItems(
        [
          {
            tweetId: "123",
            text: "old",
            authorHandle: "alice",
            tweetCreatedAt: item.created_at,
            externalUrls: ["https://example.com"],
            seenLiked: true,
            seenBookmarked: false,
          },
        ],
        { xSavedDb: db },
      );
      db.prepare(
        "UPDATE x_item_state SET status = 'keep', note = 'my note' WHERE tweet_id = '123'",
      ).run();
      const capture = {
        tweet_id: item.tweet_id,
        url: item.url,
        text: item.text,
        kind: "bookmark",
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await post({
          items: [item, capture],
          idempotency_key: "same-request",
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          accepted: ["like:123", "bookmark:123"],
        });
        expect(db.prepare("SELECT * FROM x_items").all()).toEqual([
          expect.objectContaining({
            tweet_id: "123",
            seen_liked: 1,
            seen_bookmarked: 1,
            author_handle: "alice",
            tweet_created_at: item.created_at,
            external_urls_json: '["https://example.com"]',
          }),
        ]);
        expect(db.prepare("SELECT * FROM x_item_state").all()).toEqual([
          expect.objectContaining({ status: "keep", note: "my note" }),
        ]);
      }
    } finally {
      db.close();
    }
  });

  it("accepts 50 items and deduplicates ACK keys", async () => {
    const response = await post({
      items: Array.from({ length: 50 }, () => item),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: ["like:123"] });
  });

  it.each([
    { items: [] },
    { items: Array.from({ length: 51 }, () => item) },
    { items: [item, { ...item, kind: "unlike" }] },
    { items: [item, { ...item, tweet_id: 123 }] },
    { items: [{ ...item, url: "https://x.com/alice/status/456" }] },
    { items: [{ ...item, created_at: "yesterday" }] },
    { items: [{ ...item, externalUrls: [] }] },
    { items: [{ ...item, author: null }] },
    { items: [item], unexpected: true },
  ])("rejects the entire invalid batch without writes: %j", async (payload) => {
    const db = openXSavedDb(dbPath);
    try {
      expect((await post(payload)).status).toBe(400);
      expect(db.prepare("SELECT * FROM x_items").all()).toEqual([]);
      expect(db.prepare("SELECT * FROM x_item_state").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rolls back a failed batch and never ACKs it", async () => {
    const db = openXSavedDb(dbPath);
    try {
      db.exec(
        "CREATE TRIGGER fail_insert BEFORE INSERT ON x_items WHEN NEW.tweet_id = '456' BEGIN SELECT RAISE(ABORT, 'failed'); END",
      );
      const response = await post({
        items: [
          item,
          { ...item, tweet_id: "456", url: "https://x.com/alice/status/456" },
        ],
      });
      expect(response.status).toBe(500);
      expect(await response.json()).not.toHaveProperty("accepted");
      expect(db.prepare("SELECT * FROM x_items").all()).toEqual([]);
      expect(db.prepare("SELECT * FROM x_item_state").all()).toEqual([]);
      db.exec("DROP TRIGGER fail_insert");
      expect((await post({ items: [item] })).status).toBe(200);
    } finally {
      db.close();
    }
  });

  it("rejects bad HTTP requests and oversized bodies", async () => {
    expect((await fetch(endpoint)).status).toBe(405);
    expect((await fetch(`${endpoint}/wrong`)).status).toBe(404);
    expect((await fetch(endpoint, { method: "POST", body: "{}" })).status).toBe(
      415,
    );
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://evil.example",
          },
          body: JSON.stringify({ items: [item] }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: " ".repeat(MAX_BODY_BYTES + 1),
        })
      ).status,
    ).toBe(413);
  });
});
