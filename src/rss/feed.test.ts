import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFeed, parseFeedBytes, parseFeedBytesInBatches } from "./feed.js";

const BASE_URL = "https://example.com/feeds/latest.xml";

function utf8(xml: string): Buffer {
  return Buffer.from(xml, "utf8");
}

function parseUtf8(xml: string, baseUrl = BASE_URL) {
  return parseFeedBytes(utf8(xml), { baseUrl });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseFeedBytes", () => {
  it("件数を切り捨てず100件ずつ処理する", async () => {
    const itemCount = 205;
    const items = Array.from(
      { length: itemCount },
      (_, index) =>
        `<item><guid>item-${index}</guid><title>記事${index}</title></item>`,
    ).join("");
    const batches: string[][] = [];

    const metadata = await parseFeedBytesInBatches(
      utf8(
        `<?xml version="1.0"?><rss version="2.0"><channel><title>Many Items</title>${items}</channel></rss>`,
      ),
      { baseUrl: BASE_URL },
      (entries) => batches.push(entries.map((entry) => entry.entryId)),
    );

    expect(metadata.title).toBe("Many Items");
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 5]);
    expect(batches.flat()).toHaveLength(itemCount);
    expect(batches.flat().at(-1)).toBe("guid:item-204");
  });

  it("RSS 2.0のCDATA概要をテキストへ変換する", async () => {
    const feed = await parseUtf8(`<?xml version="1.0"?>
        <rss version="2.0"><channel><title>Test Feed</title>
          <item><guid>new-1</guid><title>新着記事</title>
            <link>https://example.com/new</link>
            <pubDate>Thu, 16 Jul 2026 00:00:00 GMT</pubDate>
            <description><![CDATA[<p>新着の概要です。</p>]]></description>
          </item>
        </channel></rss>`);
    expect(feed.title).toBe("Test Feed");
    expect(feed.entries[0]).toMatchObject({
      entryId: "guid:new-1",
      title: "新着記事",
      link: "https://example.com/new",
      publishedAt: "2026-07-16T00:00:00.000Z",
      summary: "新着の概要です。",
    });
  });

  it("Atomのalternate linkとIDを取得する", async () => {
    const feed = await parseUtf8(`<?xml version="1.0"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Atom Feed</title>
          <entry><id>tag:example,1</id><title>Atom記事</title>
            <link rel="alternate" href="https://example.com/atom" />
            <summary>Atom概要</summary>
          </entry>
        </feed>`);
    expect(feed.entries[0]).toMatchObject({
      entryId: "guid:tag:example,1",
      link: "https://example.com/atom",
      summary: "Atom概要",
    });
  });

  it("RDF 1.0を共通形式へ変換する", async () => {
    const feed = await parseUtf8(`<?xml version="1.0"?>
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
          xmlns="http://purl.org/rss/1.0/">
          <channel rdf:about="https://example.com/"><title>RDF Feed</title></channel>
          <item rdf:about="https://example.com/rdf-1">
            <title>RDF記事</title><link>https://example.com/rdf-1</link>
            <description>RDF概要</description>
          </item>
        </rdf:RDF>`);
    expect(feed.title).toBe("RDF Feed");
    expect(feed.entries[0]).toMatchObject({
      entryId: "link:https://example.com/rdf-1",
      title: "RDF記事",
      link: "https://example.com/rdf-1",
      summary: "RDF概要",
    });
  });

  it("数字だけのGUIDも文字列のまま保持する", async () => {
    const feed = await parseUtf8(`<?xml version="1.0"?>
        <rss version="2.0"><channel><title>Feed</title>
          <item><guid>00123</guid><title>記事</title></item>
        </channel></rss>`);
    expect(feed.entries[0]?.entryId).toBe("guid:00123");
  });

  it("GUIDとリンクがない記事には内容由来の安定IDを付ける", async () => {
    const body = utf8(
      '<rss version="2.0"><channel><title>Feed</title><item><title>記事</title></item></channel></rss>',
    );

    const first = await parseFeedBytes(body, { baseUrl: BASE_URL });
    const second = await parseFeedBytes(body, { baseUrl: BASE_URL });

    expect(first.entries[0]?.entryId).toMatch(/^hash:[0-9a-f]{64}$/);
    expect(second.entries[0]?.entryId).toBe(first.entries[0]?.entryId);
  });

  it("概要を12,000文字に制限する", async () => {
    const feed = await parseUtf8(
      `<rss version="2.0"><channel><title>Feed</title><item>
        <guid>long</guid><title>記事</title><description>${"あ".repeat(12_050)}</description>
      </item></channel></rss>`,
    );

    expect(feed.entries[0]?.summary).toHaveLength(12_000);
  });

  it("UTF-16のBOMとXML宣言に従ってデコードする", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-16"?>
      <rss version="2.0"><channel><title>日本語フィード</title>
        <item><guid>utf16</guid><title>日本語の記事</title></item>
      </channel></rss>`;
    const body = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(xml, "utf16le"),
    ]);

    const feed = await parseFeedBytes(body, { baseUrl: BASE_URL });

    expect(feed.title).toBe("日本語フィード");
    expect(feed.entries[0]?.title).toBe("日本語の記事");
  });

  it("Shift_JISのXML宣言に従ってデコードする", async () => {
    const body = Buffer.concat([
      Buffer.from(
        '<?xml version="1.0" encoding="Shift_JIS"?><rss version="2.0"><channel><title>',
        "ascii",
      ),
      Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]),
      Buffer.from("</title></channel></rss>", "ascii"),
    ]);

    const feed = await parseFeedBytes(body, { baseUrl: BASE_URL });

    expect(feed.title).toBe("日本語");
  });

  it("HTTP Content-Typeのcharsetに従ってデコードする", async () => {
    const body = Buffer.concat([
      Buffer.from(
        '<?xml version="1.0"?><rss version="2.0"><channel><title>Caf',
        "ascii",
      ),
      Buffer.from([0xe9]),
      Buffer.from("</title></channel></rss>", "ascii"),
    ]);

    const feed = await parseFeedBytes(body, {
      baseUrl: BASE_URL,
      contentType: "application/rss+xml; charset=ISO-8859-1",
    });

    expect(feed.title).toBe("Café");
  });

  it("相対Atomリンクを最終レスポンスURLに対して解決する", async () => {
    const feed = await parseUtf8(
      `<?xml version="1.0"?>
        <feed xmlns="http://www.w3.org/2005/Atom"><title>Feed</title>
          <entry><id>relative</id><title>記事</title><link href="../posts/1" /></entry>
        </feed>`,
      "https://cdn.example.com/redirected/feed.xml",
    );

    expect(feed.entries[0]?.link).toBe("https://cdn.example.com/posts/1");
  });

  it("階層的なxml:baseを相対Atomリンクへ反映する", async () => {
    const feed = await parseUtf8(`<?xml version="1.0"?>
        <feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://cdn.example.com/base/">
          <title>Feed</title>
          <entry xml:base="posts/"><id>xml-base</id><title>記事</title>
            <link href="1" />
          </entry>
        </feed>`);

    expect(feed.entries[0]?.link).toBe("https://cdn.example.com/base/posts/1");
  });

  it("ネストしたAtom XHTMLのタイトルと概要をテキスト化する", async () => {
    const feed = await parseUtf8(`<?xml version="1.0"?>
        <feed xmlns="http://www.w3.org/2005/Atom"><title>Feed</title>
          <entry><id>xhtml</id>
            <title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">
              <p>ネストした <strong>タイトル</strong></p>
            </div></title>
            <summary type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">
              <p>ネストした <em>概要</em>です。</p>
            </div></summary>
          </entry>
        </feed>`);

    expect(feed.entries[0]).toMatchObject({
      title: "ネストした タイトル",
      summary: "ネストした 概要です。",
    });
  });

  it("フィードではないXMLを空フィードとして扱わない", async () => {
    await expect(parseUtf8("<not-a-feed />")).rejects.toThrow();
  });
});

describe("fetchFeed", () => {
  it("Content-Lengthが5 MiBを超える場合は本文をキャンセルする", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: { "content-length": String(5 * 1024 * 1024 + 1) },
          }),
      ),
    );

    await expect(fetchFeed(BASE_URL)).rejects.toThrow(
      "RSSがサイズ上限を超えています",
    );
    expect(cancelled).toBe(true);
  });

  it("Content-Lengthが実際より小さくても5 MiB超過時点で本文の読み取りを中断する", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(chunk);
        if (pulls === 10) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: { "content-length": "1" },
          }),
      ),
    );

    await expect(fetchFeed(BASE_URL)).rejects.toThrow(
      "RSSがサイズ上限を超えています",
    );
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
  });

  it("リダイレクト後のレスポンスURLをリンク解決の基準にする", async () => {
    const response = new Response(
      `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
        <title>Feed</title><entry><id>redirect</id><title>記事</title>
        <link href="posts/1" /></entry></feed>`,
      { status: 200 },
    );
    Object.defineProperty(response, "url", {
      value: "https://cdn.example.com/redirected/feed.xml",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );

    const result = await fetchFeed(BASE_URL);

    expect(result.notModified).toBe(false);
    if (!result.notModified) {
      expect(result.feed.entries[0]?.link).toBe(
        "https://cdn.example.com/redirected/posts/1",
      );
    }
  });

  it("ETagとLast-Modifiedを送信し、レスポンス値を返す", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          '<rss version="2.0"><channel><title>Feed</title></channel></rss>',
          {
            status: 200,
            headers: {
              etag: '"new"',
              "last-modified": "Sun, 19 Jul 2026 00:00:00 GMT",
            },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchFeed(BASE_URL, {
      etag: '"old"',
      lastModified: "Sat, 18 Jul 2026 00:00:00 GMT",
    });

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("accept")).toContain("application/rdf+xml");
    expect(headers.get("if-none-match")).toBe('"old"');
    expect(headers.get("if-modified-since")).toBe(
      "Sat, 18 Jul 2026 00:00:00 GMT",
    );
    expect(result).toMatchObject({
      notModified: false,
      etag: '"new"',
      lastModified: "Sun, 19 Jul 2026 00:00:00 GMT",
    });
  });

  it("304を本文なしの未更新結果として返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 304 })),
    );

    await expect(fetchFeed(BASE_URL)).resolves.toEqual({ notModified: true });
  });
});
