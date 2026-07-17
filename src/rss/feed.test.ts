import { describe, expect, it } from "vitest";
import { parseFeedXml } from "./feed.js";

describe("parseFeedXml", () => {
  it("RSS 2.0のCDATA概要をテキストへ変換する", () => {
    const feed = parseFeedXml(`<?xml version="1.0"?>
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

  it("Atomのalternate linkとIDを取得する", () => {
    const feed = parseFeedXml(`<?xml version="1.0"?>
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

  it("数字だけのGUIDも文字列のまま保持する", () => {
    const feed = parseFeedXml(`<?xml version="1.0"?>
      <rss version="2.0"><channel><title>Feed</title>
        <item><guid>00123</guid><title>記事</title></item>
      </channel></rss>`);
    expect(feed.entries[0]?.entryId).toBe("guid:00123");
  });
});
