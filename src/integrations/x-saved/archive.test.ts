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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_MAX_BYTES,
  lookupArchiveMedia,
  parseArchiveMedia,
  saveArchiveFile,
  VIDEO_MAX_BYTES,
} from "./archive.js";
import { isMediaUrl, MediaHintsSchema } from "./media-contract.js";

const image = "https://pbs.twimg.com/media/example.jpg?name=orig";
const video =
  "https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/1280x720/example.mp4?tag=12";
// Reduced from live /2/status/1841206275088290279 and /1848831595014459513.
const photo = { type: "photo", url: image, altText: "diagram" };
const movie = {
  type: "video",
  url: video,
  formats: [
    {
      container: "m3u8",
      url: "https://video.twimg.com/ext_tw_video/123/pu/pl/example.m3u8",
    },
    {
      container: "mp4",
      bitrate: 832000,
      url: video.replace("1280x720", "640x360"),
    },
    { container: "mp4", bitrate: 2176000, url: video },
  ],
};
function fx(all: unknown[] = []) {
  return {
    code: 200,
    status: {
      id: "123",
      type: "status",
      provider: "twitter",
      media: { all },
      quote: { media: { all: [photo] } },
    },
  };
}

describe("archive media contract", () => {
  it("parses only ordered focal media, picking the highest MP4 bitrate", () => {
    expect(
      parseArchiveMedia(fx([movie, photo, { type: "gif", url: video }]), "123"),
    ).toEqual([
      { kind: "video", position: 0, source_url: video },
      { kind: "image", position: 1, source_url: image, alt_text: "diagram" },
      { kind: "video", position: 2, source_url: video },
    ]);
    expect(parseArchiveMedia(fx(), "123")).toEqual([]);
    expect(
      parseArchiveMedia(
        {
          code: 200,
          status: { id: "123", type: "status", provider: "twitter", media: {} },
        },
        "123",
      ),
    ).toEqual([]);
  });
  it("keeps HLS-only video presence without fetching HLS", () => {
    expect(
      parseArchiveMedia(
        fx([{ type: "video", url: "https://video.twimg.com/a.m3u8" }]),
        "123",
      ),
    ).toEqual([{ kind: "video", position: 0, source_url: undefined }]);
  });
  it.each([
    {},
    { code: 404 },
    { ...fx(), code: 500 },
    { ...fx(), status: { ...fx().status, id: "124" } },
    { ...fx(), status: { ...fx().status, media: { photos: [photo] } } },
    {
      ...fx(),
      status: { ...fx().status, media: { all: [], videos: [movie] } },
    },
    fx([{ type: "unknown" }]),
    fx([{ type: "photo" }]),
    fx([{ ...photo, url: "https://localhost/private" }]),
    fx([
      {
        ...movie,
        formats: [
          {
            container: "mp4",
            bitrate: 9999999,
            url: "https://evil.example/video.mp4",
          },
        ],
      },
    ]),
  ])("rejects malformed, mismatched or unsafe response %j", (response) => {
    expect(() => parseArchiveMedia(response, "123")).toThrow();
  });
  it.each([
    "http://pbs.twimg.com/media/a.jpg",
    "https://pbs.twimg.com.evil/media/a.jpg",
    "https://user:pass@pbs.twimg.com/media/a.jpg",
    "https://pbs.twimg.com:444/media/a.jpg",
    "https://pbs.twimg.com/media/a.jpg#x",
    "https://pbs.twimg.com/profile_images/a.jpg",
    "https://127.0.0.1/media/a.jpg",
    "data:image/png,a",
    "blob:https://x.com/a",
    "https://pbs.twimg.com/media/a%2f..%2fb.jpg",
  ])("rejects image URL %s at the wire and download boundary", (url) => {
    expect(isMediaUrl(url, "image")).toBe(false);
    expect(
      MediaHintsSchema.safeParse([
        { kind: "image", position: 0, source_url: url },
      ]).success,
    ).toBe(false);
  });
  it("accepts PR #2 hints but never a browser video source or duplicate key", () => {
    expect(
      MediaHintsSchema.safeParse([
        { kind: "image", position: 0, source_url: image },
        { kind: "video", position: 1 },
      ]).success,
    ).toBe(true);
    expect(
      MediaHintsSchema.safeParse([
        { kind: "video", position: 0, source_url: video },
      ]).success,
    ).toBe(false);
    expect(
      MediaHintsSchema.safeParse([
        { kind: "video", position: 0 },
        { kind: "video", position: 0 },
      ]).success,
    ).toBe(false);
  });
});

describe("archive network and files", () => {
  let root: string;
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "x-archive-"));
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
  });
  it("uses ID only, no auth or redirects, and a bounded request", async () => {
    fetchMock.mockResolvedValue(Response.json(fx([movie])));
    expect(await lookupArchiveMedia("123")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.fxtwitter.com/2/status/123",
      expect.objectContaining({
        credentials: "omit",
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    await expect(lookupArchiveMedia("../123")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([
    () =>
      new Response("", {
        status: 302,
        headers: { location: "https://evil.example" },
      }),
    () => new Response("", { status: 404 }),
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    () =>
      new Response("{", { headers: { "content-type": "application/json" } }),
    () =>
      new Response(" ".repeat(2 * 1024 * 1024 + 1), {
        headers: { "content-type": "application/json" },
      }),
  ])("rejects failed/non-JSON/oversized FxTwitter responses", async (response) => {
    fetchMock.mockResolvedValue(response());
    await expect(lookupArchiveMedia("123")).rejects.toThrow();
  });
  it("tries orig first, falls back only on failure, returns a relative path", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(
        new Response("png-data", { headers: { "content-type": "image/png" } }),
      );
    const source = "https://pbs.twimg.com/media/a?format=png&name=small";
    expect(
      await saveArchiveFile(root, "123", {
        kind: "image",
        position: 0,
        source_url: source,
      }),
    ).toBe("media/123/0.png");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("name=orig");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(source);
    expect(await readFile(path.join(root, "media/123/0.png"), "utf8")).toBe(
      "png-data",
    );
    expect(await readdir(path.join(root, "media/123"))).toEqual(["0.png"]);
  });
  it("streams an MP4 larger than the image cap without buffering the response", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let remaining = 11;
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            if (remaining-- > 0) controller.enqueue(chunk);
            else controller.close();
          },
        }),
        { headers: { "content-type": "video/mp4" } },
      ),
    );
    const relative = await saveArchiveFile(root, "123", {
      kind: "video",
      position: 1,
      source_url: video,
    });
    expect(relative).toBe("media/123/1.mp4");
    expect((await readFile(path.join(root, relative))).length).toBe(
      11 * 1024 * 1024,
    );
  });
  it("counts streamed bytes even without Content-Length and cleans oversized MP4 temp files", async () => {
    let remaining = VIDEO_MAX_BYTES / (1024 * 1024) + 1;
    const chunk = new Uint8Array(1024 * 1024);
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            if (remaining-- > 0) controller.enqueue(chunk);
            else controller.close();
          },
        }),
        { headers: { "content-type": "video/mp4" } },
      ),
    );
    await expect(
      saveArchiveFile(root, "123", {
        kind: "video",
        position: 0,
        source_url: video,
      }),
    ).rejects.toThrow("byte limit");
    expect(await readdir(path.join(root, "media/123"))).toEqual([]);
  }, 30_000);
  it.each([
    "image",
    "video",
  ] as const)("rejects oversized %s headers", async (kind) => {
    fetchMock.mockResolvedValue(
      new Response("x", {
        headers: {
          "content-type": kind === "image" ? "image/jpeg" : "video/mp4",
          "content-length": String(
            (kind === "image" ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES) + 1,
          ),
        },
      }),
    );
    await expect(
      saveArchiveFile(root, "123", {
        kind,
        position: 0,
        source_url: kind === "image" ? image : video,
      }),
    ).rejects.toThrow("byte limit");
    expect(await readdir(path.join(root, "media/123"))).toEqual([]);
  });
  it("does not publish partial downloads; only replaces the final file after stream completion", async () => {
    await mkdir(path.join(root, "media/123"), { recursive: true });
    await writeFile(path.join(root, "media/123/0.jpg"), "previous");
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(new TextEncoder().encode("new"));
      },
    });
    fetchMock.mockResolvedValue(
      new Response(body, { headers: { "content-type": "image/jpeg" } }),
    );
    const saving = saveArchiveFile(root, "123", {
      kind: "image",
      position: 0,
      source_url: image,
    });
    await vi.waitFor(async () =>
      expect(
        (await readdir(path.join(root, "media/123"))).some((p) =>
          p.endsWith(".part"),
        ),
      ).toBe(true),
    );
    expect(await readFile(path.join(root, "media/123/0.jpg"), "utf8")).toBe(
      "previous",
    );
    controller?.close();
    await saving;
    expect(await readFile(path.join(root, "media/123/0.jpg"), "utf8")).toBe(
      "new",
    );
  });
  it("cleans a partially written temp after a network error and preserves the existing file", async () => {
    await mkdir(path.join(root, "media/123"), { recursive: true });
    await writeFile(path.join(root, "media/123/0.jpg"), "previous");
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
            value.enqueue(new Uint8Array(4096));
          },
        }),
        { headers: { "content-type": "image/jpeg" } },
      ),
    );
    const saving = saveArchiveFile(root, "123", {
      kind: "image",
      position: 0,
      source_url: image,
    });
    const rejected = expect(saving).rejects.toThrow("broken stream");
    await vi.waitFor(async () =>
      expect((await readdir(path.join(root, "media/123"))).length).toBe(2),
    );
    controller?.error(new Error("broken stream"));
    await rejected;
    expect(await readdir(path.join(root, "media/123"))).toEqual(["0.jpg"]);
    expect(await readFile(path.join(root, "media/123/0.jpg"), "utf8")).toBe(
      "previous",
    );
  });
  it.each([
    "https://localhost/a.mp4",
    "https://video.twimg.com:123/tweet_video/a.mp4",
    "https://user@video.twimg.com/tweet_video/a.mp4",
    "https://video.twimg.com/tweet_video/a.m3u8",
  ])("never fetches unsafe video URL %s", async (url) => {
    await expect(
      saveArchiveFile(root, "123", {
        kind: "video",
        position: 0,
        source_url: url,
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects traversal and symlink directories before fetching", async () => {
    await expect(
      saveArchiveFile(root, "../123", {
        kind: "image",
        position: 0,
        source_url: image,
      }),
    ).rejects.toThrow();
    await symlink(os.tmpdir(), path.join(root, "media"));
    await expect(
      saveArchiveFile(root, "123", {
        kind: "image",
        position: 0,
        source_url: image,
      }),
    ).rejects.toThrow("Unsafe");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    206, 302, 500,
  ])("rejects HTTP %i instead of following redirects", async (status) => {
    fetchMock.mockResolvedValue(
      new Response("", {
        status,
        headers: { location: "http://127.0.0.1/secret" },
      }),
    );
    await expect(
      saveArchiveFile(root, "123", {
        kind: "video",
        position: 0,
        source_url: video,
      }),
    ).rejects.toThrow("HTTP");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      credentials: "omit",
      redirect: "error",
    });
  });
  it.each([
    "text/html",
    "constructor",
    "application/octet-stream",
  ])("rejects unsupported MIME %s", async (mime) => {
    fetchMock.mockResolvedValue(
      new Response("x", { headers: { "content-type": mime } }),
    );
    await expect(
      saveArchiveFile(root, "123", {
        kind: "image",
        position: 0,
        source_url: image,
      }),
    ).rejects.toThrow("content type");
  });
});
