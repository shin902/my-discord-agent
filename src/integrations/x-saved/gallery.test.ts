import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startXSavedGallery } from "./gallery.js";
import {
  formatLabels,
  GalleryFilterSchema,
  getGalleryItem,
  listGallery,
  updateGalleryItem,
} from "./gallery-store.js";
import { escapeHtml } from "./gallery-view.js";
import { ingestXSavedItems, openXSavedDb } from "./store.js";

const origin = "https://gallery.example.ts.net";
const classification = {
  series: "作品A\n作品B",
  character: "Alice\nBob\nAlice",
  tag: "art\nblue",
  status: "keep",
};
const longLabels = Array.from(
  { length: 50 },
  (_, i) => String(i).padStart(2, "0") + "漢".repeat(98),
).join("\n");
// A local, credential-free image; the gallery never fetches a remote URL.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

describe("x-saved gallery", () => {
  let root: string;
  let dbPath: string;
  let db: Database.Database;
  let server: Server;
  let endpoint: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "x-saved-gallery-"));
    dbPath = path.join(root, "saved.sqlite");
    db = openXSavedDb(dbPath);
    ingestXSavedItems(
      [
        {
          tweetId: "123",
          text: "Blue art 100% <script>alert(1)</script>",
          authorHandle: "alice",
          tweetCreatedAt: "2026-09-01T23:00:00-02:00",
          seenLiked: true,
          seenBookmarked: true,
          media: [
            {
              kind: "image",
              position: 0,
              source_url: "https://pbs.twimg.com/media/a.jpg",
              alt_text: '"><script>alert(2)</script>',
            },
            { kind: "video", position: 1 },
          ],
        },
        {
          tweetId: "456",
          text: "red art",
          authorHandle: "bob",
          tweetCreatedAt: "2026-08-01T00:00:00Z",
          seenLiked: false,
          seenBookmarked: true,
          media: [
            {
              kind: "image",
              position: 0,
              source_url: "https://pbs.twimg.com/media/b.jpg",
            },
          ],
        },
        {
          tweetId: "789",
          text: "no media",
          seenLiked: true,
          seenBookmarked: false,
        },
      ],
      { xSavedDb: db, now: "2026-09-10T00:00:00Z" },
    );
    db.prepare(
      "UPDATE x_item_state SET note = 'preserved note' WHERE tweet_id = '123'",
    ).run();
    await mkdir(path.join(root, "media/123"), { recursive: true });
    await writeFile(path.join(root, "media/123/0.png"), png);
    await writeFile(path.join(root, "media/123/1.mp4"), "0123456789");
    db.exec(
      "UPDATE x_media SET status = 'done', local_path = 'media/123/0.png' WHERE tweet_id = '123' AND kind = 'image'; UPDATE x_media SET status = 'done', local_path = 'media/123/1.mp4' WHERE tweet_id = '123' AND kind = 'video';",
    );
    server = await startXSavedGallery({
      port: 0,
      origin,
      xSavedDbPath: dbPath,
    });
    const address = server.address() as AddressInfo;
    expect(address.address).toBe("127.0.0.1");
    endpoint = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (db.open) db.close();
    await rm(root, { recursive: true, force: true });
  });
  function get(url = "/", headers: Record<string, string> = {}) {
    return fetch(endpoint + url, { headers });
  }
  function post(
    fields: Record<string, string>,
    headers: Record<string, string> = {},
  ) {
    return fetch(`${endpoint}/items/123`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: origin, ...headers },
      body: new URLSearchParams(fields),
    });
  }
  const search = (filters: Record<string, unknown> = {}) =>
    listGallery(db, GalleryFilterSchema.parse(filters));

  it("migrates v3 in place and reopening does not reset classifications, media, or state", () => {
    const before = getGalleryItem(db, "123");
    db.exec("DROP TABLE x_item_labels; PRAGMA user_version=3;");
    const upgraded = openXSavedDb(dbPath);
    expect(upgraded.pragma("user_version", { simple: true })).toBe(4);
    expect(getGalleryItem(upgraded, "123")).toEqual(before);
    updateGalleryItem(upgraded, "123", classification);
    upgraded.close();
    const reopened = openXSavedDb(dbPath);
    expect(getGalleryItem(reopened, "123")?.labels).toHaveLength(6);
    reopened.close();
  });

  it("round-trips legacy comma/newline labels through status-only edits and exact filters", async () => {
    db.exec("CREATE TABLE x_tags (tweet_id TEXT NOT NULL, tag TEXT NOT NULL)");
    for (const tags of [
      ["AI,ML"],
      ["line\r\nbreak", "null\0byte", '\tquote"\\\t'],
      ["[literal]"],
    ]) {
      db.exec(
        "DELETE FROM x_tags; DROP TABLE x_item_labels; PRAGMA user_version=3;",
      );
      for (const tag of tags)
        db.prepare("INSERT INTO x_tags VALUES ('123', ?)").run(tag);
      openXSavedDb(dbPath).close();
      const rendered = formatLabels([...tags].sort());
      expect(await (await get("/items/123")).text()).toContain(
        escapeHtml(rendered),
      );
      expect(
        (
          await post({
            series: "",
            character: "",
            tag: rendered,
            status: "reviewed",
          })
        ).status,
      ).toBe(303);
      expect(
        getGalleryItem(db, "123")
          ?.labels.map((l) => l.value)
          .sort(),
      ).toEqual([...tags].sort());
      expect(search({ tag: rendered }).total).toBe(2);
    }
    expect(
      (await post({ ...classification, tag: "[invalid JSON]" })).status,
    ).toBe(400);
    expect(getGalleryItem(db, "123")?.status).toBe("reviewed");
  });

  it("combines every filter with exact multi-value matching and UTC dates", () => {
    updateGalleryItem(db, "123", classification);
    expect(search().total).toBe(3);
    const filters = {
      q: "BLUE",
      media: "image",
      source: "like",
      series: "作品B\n作品A",
      character: "Bob\nAlice",
      tag: "blue\nart",
      status: "keep",
      author: "@ALICE",
      from: "2026-09-02",
      to: "2026-09-02",
      sort: "newest",
    };
    expect(search(filters).items.map((r) => r.tweet_id)).toEqual(["123"]);
    for (const change of [
      { series: "作品" },
      { character: "Alice\nmissing" },
      { tag: "blue\nmissing" },
      { status: "done" },
      { author: "bob" },
      { from: "2026-09-03", to: "2026-09-03" },
      { to: "2026-09-01", from: "2026-09-01" },
      { q: "' OR 1=1 --" },
    ]) {
      expect(search({ ...filters, ...change }).total).toBe(0);
    }
    expect(search({ media: "video", source: "bookmark" }).total).toBe(1);
    expect(search({ review: "unknown" }).items.map((r) => r.tweet_id)).toEqual([
      "456",
    ]);
    expect(search({ review: "needs-review" }).total).toBe(1);
    updateGalleryItem(db, "123", { ...classification, tag: "unknown" });
    expect(search({ review: "unknown" }).total).toBe(3);
    expect(search({ q: "%" }).total).toBe(2);
    expect(search({ q: "_" }).total).toBe(0);
    expect(search({ sort: "oldest" }).items[0].tweet_id).toBe("456");
    expect(search({ sort: "newest" }).items[0].tweet_id).toBe("123");
    expect(search({ sort: "author" }).items[0].tweet_id).toBe("123");
    db.exec(
      "UPDATE x_items SET tweet_created_at = NULL WHERE tweet_id = '123'",
    );
    expect(search({ from: "2026-09-10", to: "2026-09-10" }).total).toBe(2);
  });

  it("pages thousands of media with stable boundaries and no whole-archive DOM", async () => {
    ingestXSavedItems(
      Array.from({ length: 2000 }, (_, index) => ({
        tweetId: String(1000 + index),
        text: `picture ${index}`,
        seenLiked: true,
        seenBookmarked: false,
        media: [{ kind: "video" as const, position: 0 }],
      })),
      { xSavedDb: db },
    );
    const first = search();
    const second = search({ page: 2 });
    expect(first).toMatchObject({ total: 2003, pages: 34, page: 1 });
    expect(first.items).toHaveLength(60);
    expect(second.items).toHaveLength(60);
    expect(
      new Set(
        [...first.items, ...second.items].map(
          (r) => `${r.tweet_id}:${r.kind}:${r.position}`,
        ),
      ).size,
    ).toBe(120);
    expect(search({ page: 999 }).items).toHaveLength(23);
    const html = await (await get("/?source=like&page=2")).text();
    expect(html.match(/class="card"/g)).toHaveLength(60);
    expect(html).toContain("source=like");
    expect(html).toContain("page=3");
  });

  it("keeps long Unicode filters through detail, POST redirect, and return without nested URLs", async () => {
    const values = longLabels;
    const fields = {
      series: values,
      character: values,
      tag: values,
      status: "keep",
    };
    updateGalleryItem(db, "123", fields);
    const query = new URLSearchParams({
      series: values,
      character: values,
      tag: JSON.stringify(values.split("\n")),
      media: "image",
    });
    expect(query.toString().length).toBeGreaterThan(16 * 1024);
    const list = await get(`/?${query}`);
    expect(list.status).toBe(200);
    expect(list.headers.get("referrer-policy")).toBe("origin");
    const link = (await list.text())
      .match(/class="card-link" href="([^"]+)"/)?.[1]
      .replaceAll("&amp;", "&");
    expect(link).toBeDefined();
    expect(link).not.toContain("back=");
    expect((await get(link)).status).toBe(200);
    const saved = await fetch(endpoint + link, {
      method: "POST",
      headers: { Origin: origin },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("#saved");
    const back = `/?${new URL(endpoint + link).searchParams}`;
    expect(await (await get(link)).text()).toContain(
      `href="${escapeHtml(back)}">← 一覧に戻る`,
    );
    expect((await get(back)).status).toBe(200);
  });

  it("saves atomically, clears labels, preserves receiver metadata/notes/files, and persists across connections", async () => {
    const before = db
      .prepare("SELECT * FROM x_items WHERE tweet_id='123'")
      .get();
    const media = db.prepare("SELECT * FROM x_media").all();
    const response = await post(classification);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("#saved");
    expect(await (await get("/items/123")).text()).toContain(
      "変更を保存しました。",
    );
    expect(
      db.prepare("SELECT * FROM x_items WHERE tweet_id='123'").get(),
    ).toEqual(before);
    expect(db.prepare("SELECT * FROM x_media").all()).toEqual(media);
    expect(getGalleryItem(db, "123")).toMatchObject({
      status: "keep",
      note: "preserved note",
      labels: expect.arrayContaining([{ kind: "character", value: "Alice" }]),
    });
    expect(getGalleryItem(db, "123")?.labels).toHaveLength(6);
    ingestXSavedItems(
      [
        {
          tweetId: "123",
          text: "recaptured",
          seenLiked: true,
          seenBookmarked: false,
        },
      ],
      { xSavedDbPath: dbPath },
    );
    expect(getGalleryItem(db, "123")?.labels).toHaveLength(6);
    expect(getGalleryItem(db, "123")?.status).toBe("keep");
    expect(await readFile(path.join(root, "media/123/0.png"))).toEqual(png);
    const invalid = await post({
      ...classification,
      series: "x".repeat(101),
      status: "done",
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("x".repeat(101));
    expect(getGalleryItem(db, "123")?.status).toBe("keep");
    db.exec(
      "CREATE TRIGGER reject_label BEFORE INSERT ON x_item_labels WHEN NEW.value = 'reject' BEGIN SELECT RAISE(ABORT, 'private database detail'); END;",
    );
    const failed = await post({
      ...classification,
      tag: "reject",
      status: "done",
    });
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("private database detail");
    expect(getGalleryItem(db, "123")?.labels).toHaveLength(6);
    expect(getGalleryItem(db, "123")?.status).toBe("keep");
    expect(
      (await post({ series: "", character: "", tag: "", status: "reviewed" }))
        .status,
    ).toBe(303);
    expect(getGalleryItem(db, "123")?.labels).toEqual([]);
  });

  it("trusts Tailnet access without identity headers, requires same-origin POST, and accepts only GET/POST", async () => {
    for (const url of [
      "/",
      "/gallery.css",
      "/items/123",
      "/media/123/image/0",
      "/media/123/video/1",
    ]) {
      expect((await get(url)).status).toBe(200);
    }
    for (const Origin of ["https://evil.example", "null", ""]) {
      expect((await post(classification, { Origin })).status).toBe(403);
    }
    expect(getGalleryItem(db, "123")?.status).toBe("inbox");
    const head = await fetch(endpoint, { method: "HEAD" });
    expect(head.status).toBe(405);
    expect(head.headers.get("allow")).toBe("GET, POST");
    expect((await get("/v1/x-saved/items")).status).toBe(404);
  });

  it("escapes stored and reflected content, restricts links, and provides native lazy images/video controls", async () => {
    const html = await (await get("/?q=%22%3E%3Cscript%3E")).text();
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
    expect(html).not.toContain("<script>");
    updateGalleryItem(db, "123", {
      ...classification,
      tag: '<img src=x onerror="alert(3)">',
    });
    const response = await get("/items/123");
    const detail = await response.text();
    expect(detail).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(detail).toContain("&lt;img src=x onerror=&quot;alert(3)&quot;&gt;");
    expect(detail).toContain('loading="lazy"');
    expect(detail).toContain("playsinline controls");
    expect(detail).toContain('href="/?"');
    expect(detail).toContain("https://x.com/i/status/123");
  });

  it("rejects invalid filters and edits without changing state", async () => {
    expect((await get("/?from=2026-09-02&to=2026-09-01")).status).toBe(400);
    expect((await post({ ...classification, status: "unknown" })).status).toBe(
      400,
    );
    expect(
      (await post({ ...classification, tag: "a".repeat(256 * 1024) })).status,
    ).toBe(413);
    expect(getGalleryItem(db, "123")?.status).toBe("inbox");
  });

  it("serves completed images at route-derived paths and MP4 ranges for playback/seek", async () => {
    // The DB supplies only the image format, not the path to open.
    db.exec(
      "UPDATE x_media SET local_path='format.png' WHERE tweet_id='123' AND kind='image'",
    );
    const image = await get("/media/123/image/0");
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    for (const [Range, expected] of [
      ["bytes=2-5", "2345"],
      ["bytes=7-", "789"],
      ["bytes=-3", "789"],
    ]) {
      const response = await get("/media/123/video/1", { Range });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-type")).toBe("video/mp4");
      expect(await response.text()).toBe(expected);
    }
    expect(
      (await get("/media/123/video/1", { Range: "bytes=10-" })).status,
    ).toBe(416);
    db.exec(
      "UPDATE x_media SET status='pending' WHERE tweet_id='123' AND kind='image'",
    );
    expect((await get("/media/123/image/0")).status).toBe(404);
    db.exec(
      "UPDATE x_media SET status='done' WHERE tweet_id='123' AND kind='image'",
    );
    await rm(path.join(root, "media/123/0.png"));
    expect((await get("/media/123/image/0")).status).toBe(404);
  });

  it.runIf(process.env.X_SAVED_GALLERY_BROWSER_TEST === "1")(
    "browser: desktop/mobile filter, detail, edit and return to filtered results",
    async () => {
      // One-second synthetic H.264 fixture: exercise real MP4 decoding too.
      await writeFile(
        path.join(root, "media/123/1.mp4"),
        await readFile(new URL("./gallery-video.fixture.mp4", import.meta.url)),
      );
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        page.setDefaultTimeout(5_000);
        // Real HTTP navigation/redirects without Tailnet. Translate only this
        // local browser origin to the configured HTTPS origin; null/foreign origins still fail.
        server.prependListener("request", (request) => {
          if (request.headers.origin === endpoint)
            request.headers.origin = origin;
        });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(endpoint);
          await page.getByText("フィルター", { exact: true }).click();
          await page.getByLabel("Media", { exact: true }).selectOption("image");
          await page.getByLabel("Tweet本文を検索").fill("Blue");
          await page.getByRole("button", { name: "条件を適用" }).click();
          expect(await page.locator(".card").count()).toBe(1);
          await page.locator(".card-link").click();
          await expect
            .poll(() =>
              page
                .locator("video")
                .evaluate(
                  (element) => (element as { readyState: number }).readyState,
                ),
            )
            .toBeGreaterThanOrEqual(2);
          await page.getByLabel("Series / 作品").fill("作品A\n作品B");
          await page.getByLabel("Characters / キャラクター").fill("Alice\nBob");
          await page.getByLabel("Tags / タグ").fill("art\nblue");
          await page.getByLabel("Status", { exact: true }).selectOption("keep");
          await page.getByRole("button", { name: "変更を保存" }).click();
          await page.getByRole("status").waitFor();
          expect(new URL(page.url()).hash).toBe("#saved");
          expect(await page.getByLabel("Series / 作品").inputValue()).toBe(
            "作品A\n作品B",
          );
          await page.getByRole("link", { name: "← 一覧に戻る" }).click();
          expect(await page.getByLabel("Tweet本文を検索").inputValue()).toBe(
            "Blue",
          );
          expect(await page.locator(".card").count()).toBe(1);
          expect(
            await page.evaluate(
              "document.documentElement.scrollWidth <= innerWidth",
            ),
          ).toBe(true);
          await page.locator(".stage img").scrollIntoViewIfNeeded();
          await expect
            .poll(() =>
              page.locator(".stage img").evaluate((element) => {
                const img = element as {
                  complete: boolean;
                  naturalWidth: number;
                };
                return img.complete && img.naturalWidth > 0;
              }),
            )
            .toBe(true);
          if (process.env.X_SAVED_GALLERY_SCREENSHOT_DIR)
            await page.screenshot({
              path: path.join(
                process.env.X_SAVED_GALLERY_SCREENSHOT_DIR,
                `gallery-${width}.png`,
              ),
              fullPage: true,
            });
        }
        // Reproduce both P2s through native forms: a >16 KiB filter URL and
        // a status-only save of labels containing literal separators.
        const tags = ["AI,ML", "line\r\nbreak", "[literal]"];
        updateGalleryItem(db, "123", {
          ...classification,
          series: longLabels,
          tag: JSON.stringify(tags),
        });
        await page.goto(endpoint);
        await page.getByText("フィルター", { exact: true }).click();
        await page.getByLabel("Media", { exact: true }).selectOption("image");
        expect(
          await page.getByLabel("Series / 作品").getAttribute("maxlength"),
        ).toBe("10000");
        await page.getByLabel("Series / 作品").fill(longLabels);
        await page.getByLabel("Tags / タグ").fill(JSON.stringify(tags));
        await page.getByRole("button", { name: "条件を適用" }).click();
        expect(page.url().length).toBeGreaterThan(16 * 1024);
        expect(await page.locator(".card").count()).toBe(1);
        await page.locator(".card-link").click();
        await page
          .getByLabel("Status", { exact: true })
          .selectOption("reviewed");
        await page.getByRole("button", { name: "変更を保存" }).click();
        await page.getByRole("status").waitFor();
        expect(new URL(page.url()).hash).toBe("#saved");
        expect(
          getGalleryItem(db, "123")
            ?.labels.filter((l) => l.kind === "tag")
            .map((l) => l.value)
            .sort(),
        ).toEqual([...tags].sort());
        await page.reload();
        await page.getByRole("link", { name: "← 一覧に戻る" }).click();
        expect(await page.getByLabel("Series / 作品").inputValue()).toBe(
          longLabels,
        );
        expect(await page.locator(".card").count()).toBe(1);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    },
    30_000,
  );
});
