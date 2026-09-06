import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const dnsLookupMock = vi.hoisted(() =>
  vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]),
);
const execAsyncMock = vi.hoisted(() => vi.fn());
const mkdtempMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  mkdtempMock.mockImplementation(actual.mkdtemp);
  return { ...actual, mkdtemp: mkdtempMock };
});
vi.mock("node:dns/promises", () => ({ lookup: dnsLookupMock }));
vi.mock("./exec.js", () => ({ execAsync: execAsyncMock }));

import { agentReachTool } from "./agent-reach.js";

const directories: string[] = [];
const originalCookieFile = process.env.REDDIT_COOKIE_FILE;
const COOKIE = "reddit_session=distinctive-cookie-secret";

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalCookieFile === undefined) delete process.env.REDDIT_COOKIE_FILE;
  else process.env.REDDIT_COOKIE_FILE = originalCookieFile;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setupCookie(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agent-reach-cookie-"));
  directories.push(directory);
  const cookieFile = join(directory, "reddit-cookies.json");
  await writeFile(
    cookieFile,
    JSON.stringify({
      cookieHeader: COOKIE,
      updatedAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  process.env.REDDIT_COOKIE_FILE = cookieFile;
}

async function executeReddit(signal?: AbortSignal): Promise<unknown> {
  return agentReachTool.execute(
    "test",
    { url: "https://www.reddit.com/r/test" },
    signal,
  );
}

describe("agent-reach Reddit cookie boundary", () => {
  it("sends the cookie only as a direct fetch header", async () => {
    await setupCookie();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"data":{"children":[]}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      agentReachTool.execute("test", { url: "https://www.reddit.com/r/test" }),
    ).resolves.toMatchObject({
      content: [
        {
          type: "text",
          text: expect.stringContaining("構造を解析できませんでした"),
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.reddit.com/r/test.json",
      expect.objectContaining({
        headers: { Cookie: COOKIE, "User-Agent": expect.any(String) },
        redirect: "error",
      }),
    );
    expect(JSON.stringify(fetchMock.mock.calls)).toContain(COOKIE);
  });

  it.each([
    ["https://www.reddit.com/", "https://www.reddit.com/.json"],
    [
      "https://www.reddit.com/r/test.json",
      "https://www.reddit.com/r/test.json",
    ],
    [
      "https://reddit.com/r/test/?sort=top#comments",
      "https://www.reddit.com/r/test.json?sort=top",
    ],
  ])("canonicalizes %s to %s", async (url, expected) => {
    await setupCookie();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"data":{"children":[]}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await agentReachTool.execute("test", { url });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(expected);
  });

  it("preserves HTTP status semantics for text and HTML errors", async () => {
    await setupCookie();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>private details</html>", {
          status: 503,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    await expect(executeReddit()).rejects.toThrow(/503/);
  });

  it("rejects successful non-JSON responses", async () => {
    await setupCookie();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("ok", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      ),
    );
    await expect(executeReddit()).rejects.toThrow("non-JSON");
  });

  it("redacts secrets from successful fallback and listing Markdown", async () => {
    await setupCookie();
    const cookiePath = process.env.REDDIT_COOKIE_FILE;
    if (!cookiePath) throw new Error("cookie path was not configured");
    const unknownBody = JSON.stringify({
      unexpected: `${COOKIE} ${cookiePath}`,
    });
    const listingBody = JSON.stringify({
      data: {
        children: [
          {
            data: {
              title: `${COOKIE} ${cookiePath}`,
              subreddit: "test",
              author: "author",
              score: 1,
              num_comments: 0,
            },
          },
        ],
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(unknownBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(listingBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const fallback = await executeReddit();
    const fallbackText = String(
      (fallback as { content: Array<{ text: string }> }).content[0]?.text,
    );
    expect(fallbackText).toContain("構造を解析できませんでした");
    expect(fallbackText).toContain('"unexpected"');
    expect(fallbackText).not.toContain(COOKIE);
    expect(fallbackText).not.toContain(cookiePath);

    const listing = await executeReddit();
    const listingText = String(
      (listing as { content: Array<{ text: string }> }).content[0]?.text,
    );
    expect(listingText).toContain("# [redacted] [redacted]");
    expect(listingText).not.toContain(COOKIE);
    expect(listingText).not.toContain(cookiePath);
  });

  it.each([
    401, 503,
  ])("redacts cookie from HTTP %s error bodies", async (status) => {
    await setupCookie();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          `upstream echoed ${COOKIE} from ${process.env.REDDIT_COOKIE_FILE}`,
          {
            status,
            headers: { "content-type": "text/plain" },
          },
        ),
      ),
    );

    await expect(executeReddit()).rejects.toSatisfy((error: unknown) => {
      const message = String(error);
      expect(message).toContain(String(status));
      expect(message).not.toContain(COOKIE);
      expect(message).not.toContain(process.env.REDDIT_COOKIE_FILE ?? "");
      return true;
    });
  });

  it("rejects declared and streamed responses over the Reddit size limit", async () => {
    await setupCookie();
    const oversized = "x".repeat(8 * 1024 * 1024 + 1);
    const declared = new Response(oversized, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(oversized)),
      },
    });
    const streamed = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(oversized));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    for (const response of [declared, streamed]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response));
      await expect(executeReddit()).rejects.toSatisfy((error: unknown) => {
        expect(String(error)).toContain("too large");
        expect(String(error)).not.toContain(COOKIE);
        return true;
      });
    }
  });

  it("aborts a pending fetch at the direct-fetch timeout", async () => {
    await setupCookie();
    vi.useFakeTimers();
    let observedSignal!: AbortSignal;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, options: { signal: AbortSignal }) => {
        observedSignal = options.signal;
        return new Promise<Response>((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("fetch aborted")),
            { once: true },
          );
        });
      }),
    );
    const pending = executeReddit();
    const handled = pending.catch(() => undefined);
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(observedSignal.aborted).toBe(true);
    await handled;
    await expect(pending).rejects.toThrow("fetch aborted");
  });

  it("keeps the timeout active while consuming a pending response body", async () => {
    await setupCookie();
    vi.useFakeTimers();
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    let observedSignal!: AbortSignal;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, options: { signal: AbortSignal }) => {
        observedSignal = options.signal;
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                bodyController = controller;
                options.signal.addEventListener("abort", () => {
                  controller.error(
                    new Error(
                      `body aborted: ${COOKIE} ${process.env.REDDIT_COOKIE_FILE}`,
                    ),
                  );
                });
              },
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
        );
      }),
    );
    const pending = executeReddit();
    const handled = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(bodyController).toBeDefined());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(observedSignal.aborted).toBe(true);
    const error = await handled;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("body aborted");
    expect((error as Error).message).not.toContain(COOKIE);
    expect((error as Error).message).not.toContain(
      process.env.REDDIT_COOKIE_FILE ?? "",
    );
    expect(execAsyncMock).not.toHaveBeenCalled();
  });

  it("does not create Runtime scratch for successful Reddit fetches", async () => {
    await setupCookie();
    mkdtempMock.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"data":{"children":[]}}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await executeReddit();
    expect(mkdtempMock).not.toHaveBeenCalledWith(
      expect.stringContaining("agent-reach-"),
    );
    expect(execAsyncMock).not.toHaveBeenCalled();
  });

  it("propagates caller abort to the fetch signal", async () => {
    await setupCookie();
    const controller = new AbortController();
    let observed!: AbortSignal;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, options: { signal: AbortSignal }) => {
        observed = options.signal;
        return new Promise<Response>((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
      }),
    );
    const pending = executeReddit(controller.signal);
    await vi.waitFor(() => expect(observed).toBeDefined());
    controller.abort();
    await vi.waitFor(() => expect(observed.aborted).toBe(true));
    await expect(pending).rejects.toThrow("aborted");
    expect(observed.aborted).toBe(true);
  });
});
