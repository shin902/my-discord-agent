import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshRedditCookiesInRuntime } from "./reddit-cookie-refresh-client.js";

const fetchMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  vi.useRealTimers();
  fetchMock.mockReset();
  delete process.env.AGENT_REACH_RUNTIME_URL;
});

describe("host Reddit cookie refresh client", () => {
  it("calls the private maintenance endpoint from the host", async () => {
    process.env.AGENT_REACH_RUNTIME_URL = "http://127.0.0.1:9876/";
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(refreshRedditCookiesInRuntime()).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9876/maintenance/reddit-cookie-refresh",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
  });

  it("retries connection failures and succeeds when Runtime becomes ready", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("refused"), {
            code: "ECONNREFUSED",
          }),
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const pending = refreshRedditCookiesInRuntime();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops after bounded connection retries", async () => {
    vi.useFakeTimers();
    const failure = new TypeError("fetch failed", {
      cause: Object.assign(new Error("unreachable"), {
        code: "EHOSTUNREACH",
      }),
    });
    fetchMock.mockRejectedValue(failure);

    const pending = refreshRedditCookiesInRuntime();
    const result = expect(pending).rejects.toBe(failure);
    await vi.runAllTimersAsync();
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it.each([
    "ECONNRESET",
    "ETIMEDOUT",
  ])("does not retry ambiguous %s failures", async (code) => {
    const failure = Object.assign(new TypeError("fetch failed"), { code });
    fetchMock.mockRejectedValueOnce(failure);

    await expect(refreshRedditCookiesInRuntime()).rejects.toBe(failure);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not retry a generic TypeError", async () => {
    const failure = new TypeError("fetch failed");
    fetchMock.mockRejectedValueOnce(failure);

    await expect(refreshRedditCookiesInRuntime()).rejects.toBe(failure);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([500, 503])("does not retry an HTTP %s response", async (status) => {
    fetchMock.mockResolvedValueOnce(new Response("refresh failed", { status }));

    await expect(refreshRedditCookiesInRuntime()).rejects.toThrow(
      "refresh failed",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
