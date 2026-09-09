import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFxTwitterMedia } from "./fxtwitter.js";

const photo = {
  type: "photo",
  url: "https://pbs.twimg.com/media/one.jpg",
  altText: "A diagram",
  width: 100,
  height: 100,
};
const status = (media: object = {}) => ({
  type: "status",
  provider: "twitter",
  id: "123",
  media,
});
const payload = (media: object = {}) => ({ code: 200, status: status(media) });
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("FxTwitter ID-only media resolver", () => {
  it("uses a fixed unauthenticated endpoint and only focal ordered metadata", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        ...payload({
          all: [
            photo,
            {
              type: "video",
              url: "https://video.twimg.com/not-downloaded.mp4",
            },
            { type: "gif", url: "blob:ignored" },
          ],
        }),
        thread: [status({ all: [photo] })],
        status: {
          ...status({
            all: [
              photo,
              {
                type: "video",
                url: "https://video.twimg.com/not-downloaded.mp4",
              },
              { type: "gif", url: "blob:ignored" },
            ],
          }),
          quote: status({ all: [photo] }),
        },
      }),
    );
    expect(await resolveFxTwitterMedia("123")).toEqual([
      {
        kind: "image",
        position: 0,
        source_url: photo.url,
        alt_text: "A diagram",
      },
      { kind: "video", position: 1 },
      { kind: "video", position: 2 },
    ]);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://api.fxtwitter.com/2/status/123",
      {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
        credentials: "omit",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it.each([
    {},
    { all: [] },
    { photos: [], videos: [] },
  ])("accepts a successful empty result: %j", async (media) => {
    fetchMock.mockResolvedValue(Response.json(payload(media)));
    expect(await resolveFxTwitterMedia("123")).toEqual([]);
  });

  it.each([
    "0",
    "../123",
    "123?url=https://evil.example",
    "1".repeat(21),
    "https://x.com/a/status/123",
  ])("rejects invalid ID %s before I/O", async (id) => {
    await expect(resolveFxTwitterMedia(id)).rejects.toThrow("Invalid Tweet ID");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { code: 404, status: null },
    { code: 200, status: { ...status(), id: "456" } },
    { code: 200, status: { ...status(), provider: "bluesky" } },
    { code: 200, status: { ...status(), type: "tombstone" } },
    { code: 200, status: { id: "123", type: "status", provider: "twitter" } },
    payload({ photos: [photo] }),
    payload({ all: [], photos: [photo] }),
    payload({ all: [photo], photos: [photo, photo] }),
    payload({ all: [{ type: "unknown", url: photo.url }] }),
    payload({ all: [{ ...photo, url: "https://evil.example/media/one" }] }),
    payload({
      all: [{ ...photo, url: "https://pbs.twimg.com/profile_images/one" }],
    }),
    payload({ all: [{ ...photo, altText: "x".repeat(10_001) }] }),
    payload({ all: Array(17).fill(photo) }),
  ])("rejects incomplete/untrusted payload %# without a partial result", async (value) => {
    fetchMock.mockResolvedValue(Response.json(value));
    await expect(resolveFxTwitterMedia("123")).rejects.toThrow(/FxTwitter/);
  });

  it.each([
    () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://evil.example" },
      }),
    () => new Response(null, { status: 429 }),
    () => new Response(null, { status: 503 }),
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    () =>
      new Response("{", { headers: { "content-type": "application/json" } }),
    () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": String(1024 * 1024 + 1),
        },
      }),
    () =>
      new Response("x".repeat(1024 * 1024 + 1), {
        headers: { "content-type": "application/json" },
      }),
  ])("rejects HTTP/redirect/body failures %#", async (response) => {
    fetchMock.mockResolvedValue(response());
    await expect(resolveFxTwitterMedia("123")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates timeouts/network failures without alternate providers or URLs", async () => {
    fetchMock.mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
    await expect(resolveFxTwitterMedia("123")).rejects.toThrow("Timed out");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
