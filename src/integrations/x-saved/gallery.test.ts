import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startXSavedGallery } from "./gallery.js";
import {
  GalleryFilterSchema,
  getGalleryItem,
  listGallery,
  updateGalleryItem,
} from "./gallery-store.js";
import { ingestXSavedItems, openXSavedDb } from "./store.js";

// Native HTTP preserves Serve's Host header (Node fetch intentionally rewrites it).
function httpFetch(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string | undefined>;
    body?: URLSearchParams | Buffer;
  } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers = { ...init.headers };
    if (init.body instanceof URLSearchParams && !headers["Content-Type"])
      headers["Content-Type"] =
        "application/x-www-form-urlencoded;charset=UTF-8";
    const request = httpRequest(
      url,
      { method: init.method, headers },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("error", reject);
        incoming.on("end", () =>
          resolve(
            new Response(
              init.method === "HEAD" ? null : Buffer.concat(chunks),
              {
                status: incoming.statusCode,
                headers: Object.fromEntries(
                  Object.entries(incoming.headers).map(([key, value]) => [
                    key,
                    Array.isArray(value) ? value.join(", ") : (value ?? ""),
                  ]),
                ),
              },
            ),
          ),
        );
      },
    );
    request.on("error", reject);
    request.end(
      init.body instanceof URLSearchParams ? init.body.toString() : init.body,
    );
  });
}

const origin = "https://gallery.example.ts.net";
const identity = {
  Host: new URL(origin).host,
  "Tailscale-User-Login": "owner@example.com",
};
const classification = {
  series: "作品A, 作品B",
  character: "Alice\nBob\nAlice",
  tag: "art, blue",
  status: "keep",
};
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
      allowedLogin: identity["Tailscale-User-Login"],
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
  function get(url = "/", headers = identity) {
    return httpFetch(endpoint + url, { headers });
  }
  function post(
    fields: Record<string, string>,
    headers: Record<string, string | undefined> = {},
  ) {
    return httpFetch(`${endpoint}/items/123`, {
      method: "POST",
      headers: { ...identity, Origin: origin, ...headers },
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

  it("combines every filter with exact multi-value matching and UTC dates", () => {
    updateGalleryItem(db, "123", classification);
    expect(search().total).toBe(3);
    const filters = {
      q: "BLUE",
      media: "image",
      source: "like",
      series: "作品B,作品A",
      character: "Bob,Alice",
      tag: "blue,art",
      status: "keep",
      author: "@ALICE",
      from: "2026-09-02",
      to: "2026-09-02",
      sort: "newest",
    };
    expect(search(filters).items.map((r) => r.tweet_id)).toEqual(["123"]);
    for (const change of [
      { series: "作品" },
      { character: "Alice,missing" },
      { tag: "blue,missing" },
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

  it("saves atomically, clears labels, preserves receiver metadata/notes/files, and persists across connections", async () => {
    const before = db
      .prepare("SELECT * FROM x_items WHERE tweet_id='123'")
      .get();
    const media = db.prepare("SELECT * FROM x_media").all();
    const response = await post({
      ...classification,
      back: "/?source=like&page=2",
    });
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("saved=1");
    expect(await (await get(location)).text()).toContain(
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

  it("authenticates every route and denies foreign/missing identity, host, Funnel, and CSRF", async () => {
    for (const url of [
      "/",
      "/gallery.css",
      "/items/123",
      "/media/123/image/0",
      "/media/123/video/1",
    ]) {
      for (const headers of [
        { Host: identity.Host },
        { ...identity, "Tailscale-User-Login": "other@example.com" },
        { ...identity, Host: "evil.example" },
        { ...identity, "Tailscale-Funnel-Request": "?1" },
      ]) {
        expect((await get(url, headers as typeof identity)).status).toBe(403);
      }
    }
    for (const headers of [
      { Origin: "https://evil.example" },
      { Origin: "null" },
      { Origin: "" },
      { "Sec-Fetch-Site": "cross-site" },
      { "Tailscale-User-Login": "other@example.com" },
    ]) {
      expect((await post(classification, headers)).status).toBe(403);
    }
    expect(getGalleryItem(db, "123")?.status).toBe("inbox");
    expect((await get("/v1/x-saved/items")).status).toBe(404);
    expect(
      (
        await httpFetch(`${endpoint}/`, {
          method: "OPTIONS",
          headers: identity,
        })
      ).status,
    ).toBe(405);
    expect((await get()).headers.get("access-control-allow-origin")).toBeNull();
  });

  it("escapes stored and reflected content, restricts links, and provides native lazy images/video controls", async () => {
    const html = await (await get("/?q=%22%3E%3Cscript%3E")).text();
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
    expect(html).not.toContain("<script>");
    const response = await get("/items/123?back=https://evil.example");
    expect(response.headers.get("content-security-policy")).toContain(
      "form-action 'self'",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const detail = await response.text();
    expect(detail).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(detail).toContain('loading="lazy"');
    expect(detail).toContain("playsinline controls");
    expect(detail).not.toContain("https://evil.example");
    expect(detail).toContain("https://x.com/i/status/123");
    expect(detail).not.toContain("https://pbs.twimg.com");
    expect(detail).not.toContain(root);
  });

  it.each([
    "?page=-1",
    "?page=1.5",
    "?page=Infinity",
    "?sort=sql",
    "?from=2026-02-30",
    "?from=2026-09-02&to=2026-09-01",
    "?q=a&q=b",
    "?unexpected=1",
    "?media=audio",
  ])("rejects invalid queries %s", async (query) => {
    expect((await get(`/${query}`)).status).toBe(400);
  });

  it("rejects invalid and oversized edits without changing state", async () => {
    for (const fields of [
      { ...classification, status: "unknown" },
      {
        ...classification,
        series: Array.from({ length: 51 }, (_, i) => `v${i}`).join(","),
      },
      { ...classification, sql: "DROP TABLE x_items" },
    ]) {
      expect((await post(fields)).status).toBe(400);
    }
    expect(
      (await post({ ...classification, tag: "a".repeat(256 * 1024) })).status,
    ).toBe(413);
    expect(
      (await post(classification, { "Content-Type": "application/json" }))
        .status,
    ).toBe(415);
    expect(
      (await post(classification, { "Content-Encoding": "gzip" })).status,
    ).toBe(415);
    expect(getGalleryItem(db, "123")?.status).toBe("inbox");
  });

  it("streams image and MP4 byte ranges for native playback/seek, including HEAD and missing archives", async () => {
    const image = await get("/media/123/image/0");
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
    for (const [range, expected, contentRange] of [
      ["bytes=2-5", "2345", "bytes 2-5/10"],
      ["bytes=7-", "789", "bytes 7-9/10"],
      ["bytes=-3", "789", "bytes 7-9/10"],
      ["bytes=0-99", "0123456789", "bytes 0-9/10"],
    ]) {
      const response = await get("/media/123/video/1", {
        ...identity,
        Range: range,
      } as typeof identity);
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(contentRange);
      expect(response.headers.get("content-type")).toBe("video/mp4");
      expect(await response.text()).toBe(expected);
    }
    for (const range of [
      "bytes=10-",
      "bytes=8-2",
      "bytes=-0",
      "bytes=",
      "bytes=0-1,3-4",
      "bytes=999999999999999999999999999-",
    ]) {
      expect(
        (
          await get("/media/123/video/1", {
            ...identity,
            Range: range,
          } as typeof identity)
        ).status,
      ).toBe(416);
    }
    const head = await httpFetch(`${endpoint}/media/123/video/1`, {
      method: "HEAD",
      headers: identity,
    });
    expect(head.headers.get("content-length")).toBe("10");
    expect(await head.text()).toBe("");
    expect((await get("/media/456/image/0")).status).toBe(404);
    await rm(path.join(root, "media/123/0.png"));
    expect((await get("/media/123/image/0")).status).toBe(404);
  });

  it("never serves arbitrary DB paths, unfinished files, symlinks, or directories", async () => {
    const setPath = (p: string) =>
      db
        .prepare(
          "UPDATE x_media SET local_path = ? WHERE tweet_id='123' AND kind='image'",
        )
        .run(p);
    for (const bad of [
      dbPath,
      "../../saved.sqlite",
      "media/123/0.svg",
      "media/456/0.png",
      "media/123/1.mp4",
    ]) {
      setPath(bad);
      expect((await get("/media/123/image/0")).status).toBe(404);
    }
    setPath("media/123/0.png");
    await rm(path.join(root, "media/123/0.png"));
    await symlink(dbPath, path.join(root, "media/123/0.png"));
    expect((await get("/media/123/image/0")).status).toBe(404);
    await rm(path.join(root, "media/123/0.png"));
    await mkdir(path.join(root, "media/123/0.png"));
    expect((await get("/media/123/image/0")).status).toBe(404);
    await rename(path.join(root, "media/123"), path.join(root, "outside"));
    await symlink(path.join(root, "outside"), path.join(root, "media/123"));
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
        await page.route(`${origin}/**`, async (route) => {
          const request = route.request();
          let response = await httpFetch(
            endpoint + request.url().slice(origin.length),
            {
              method: request.method(),
              headers: { ...(await request.allHeaders()), ...identity },
              body: request.postDataBuffer() ?? undefined,
            },
          );
          // Playwright routing only intercepts the first request in a redirect
          // chain. Follow PRG locally; the HTTP test asserts the actual 303.
          if (response.status === 303)
            response = await httpFetch(
              endpoint + response.headers.get("location"),
              { headers: identity },
            );
          await route.fulfill({
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: Buffer.from(await response.arrayBuffer()),
          });
        });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await page.goto(origin);
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
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    },
    30_000,
  );
});
