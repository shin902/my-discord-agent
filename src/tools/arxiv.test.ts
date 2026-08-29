import { afterEach, describe, expect, it, vi } from "vitest";
import {
  arxivSearchTool,
  arxivSurveyTool,
  buildArxivApiUrl,
  buildArxivSearchQuery,
  parseArxivFeed,
} from "./arxiv.js";

const ATOM_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title>ArXiv Query</title>
  <id>http://arxiv.org/api/test</id>
  <updated>2026-08-28T00:00:00Z</updated>
  <entry>
    <id>http://arxiv.org/abs/2608.12345v2</id>
    <updated>2026-08-27T12:00:00Z</updated>
    <published>2026-08-20T03:00:00Z</published>
    <title>  Speculative\n      Decoding on GPUs </title>
    <summary> A fast\n      decoding method. </summary>
    <author><name>Alice Example</name></author>
    <author><name>Bob Example</name></author>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom" />
    <category term="cs.AI" scheme="http://arxiv.org/schemas/atom" />
    <arxiv:primary_category term="cs.LG" />
    <link href="https://arxiv.org/abs/2608.12345v2" rel="alternate" type="text/html" />
    <link href="https://arxiv.org/pdf/2608.12345v2" rel="related" type="application/pdf" />
  </entry>
</feed>`;

const LEGACY_ATOM_ENTRY = `
  <entry>
    <id>http://arxiv.org/abs/hep-th/9901001v1</id>
    <updated>1999-01-02T00:00:00Z</updated>
    <published>1999-01-01T00:00:00Z</published>
    <title>Legacy paper</title>
    <summary>Legacy abstract</summary>
    <author><name>Legacy Author</name></author>
  </entry>`;

function chunkedResponse(chunks: string[], status = 200): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, { status });
}

afterEach(() => vi.unstubAllGlobals());

describe("arXiv tools", () => {
  it("builds a natural-language query with a submitted date range", () => {
    expect(
      buildArxivSearchQuery(
        ["speculative decoding", "AMD GPU"],
        "2026-08-01",
        "2026-08-28",
      ),
    ).toBe(
      '(all:"speculative decoding" OR all:"AMD GPU") AND submittedDate:[202608010000 TO 202608282359]',
    );
  });

  it("rejects an inverted date range", () => {
    expect(() =>
      buildArxivSearchQuery(["LLM inference"], "2026-08-28", "2026-08-01"),
    ).toThrow("from は to 以前の日付にしてください");
  });

  it("maps sort and search parameters into the arXiv API URL", () => {
    const url = new URL(
      buildArxivApiUrl({
        queries: ["quantization"],
        maxResults: 20,
        sort: "updated",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://export.arxiv.org/api/query",
    );
    expect(url.searchParams.get("max_results")).toBe("20");
    expect(url.searchParams.get("sortBy")).toBe("lastUpdatedDate");
    expect(url.searchParams.get("sortOrder")).toBe("descending");
  });

  it("normalizes Atom metadata into JSON-friendly papers", async () => {
    const papers = await parseArxivFeed(ATOM_FIXTURE);
    expect(papers).toEqual([
      {
        id: "2608.12345",
        version: 2,
        title: "Speculative Decoding on GPUs",
        authors: ["Alice Example", "Bob Example"],
        submitted_at: "2026-08-20T03:00:00.000Z",
        updated_at: "2026-08-27T12:00:00.000Z",
        categories: ["cs.LG", "cs.AI"],
        abstract: "A fast decoding method.",
        url: "https://arxiv.org/abs/2608.12345",
        pdf_url: "https://arxiv.org/pdf/2608.12345",
      },
    ]);
  });

  it("preserves archive slashes in legacy arXiv IDs", async () => {
    const papers = await parseArxivFeed(
      ATOM_FIXTURE.replace("</feed>", `${LEGACY_ATOM_ENTRY}\n</feed>`),
    );
    expect(papers[1]).toMatchObject({
      id: "hep-th/9901001",
      version: 1,
      url: "https://arxiv.org/abs/hep-th/9901001",
      pdf_url: "https://arxiv.org/pdf/hep-th/9901001",
    });
  });

  it("keeps distinct legacy and modern IDs distinct during survey deduplication", async () => {
    const xml = ATOM_FIXTURE.replace(
      /<entry>[\s\S]*?<\/entry>/,
      `${LEGACY_ATOM_ENTRY}
  <entry>
    <id>http://arxiv.org/abs/9901001v1</id>
    <updated>1999-01-02T00:00:00Z</updated>
    <published>1999-01-01T00:00:00Z</published>
    <title>Modern paper</title>
    <summary>Modern abstract</summary>
  </entry>`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => chunkedResponse([xml])),
    );

    const result = await arxivSurveyTool.execute("test", {
      queries: ["legacy"],
    });
    const papers = JSON.parse(
      result.content[0].type === "text" ? result.content[0].text : "",
    );
    expect(papers.map((paper: { id: string }) => paper.id)).toEqual([
      "hep-th/9901001",
      "9901001",
    ]);
  });

  it("rejects chunked oversized success responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => chunkedResponse(["x".repeat(5 * 1024 * 1024), "x"])),
    );

    await expect(
      arxivSearchTool.execute("test", { query: "oversized" }),
    ).rejects.toThrow("arXiv API 応答がサイズ上限を超えています");
  });

  it("bounds chunked oversized non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        chunkedResponse(["error ".repeat(5 * 1024 * 1024), "x"], 503),
      ),
    );

    await expect(
      arxivSearchTool.execute("test", { query: "error" }),
    ).rejects.toThrow("arXiv API 応答がサイズ上限を超えています");
  });
});
