import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshRedditCookiesInRuntime } from "./reddit-cookie-refresh-client.js";

const fetchMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
  delete process.env.AGENT_REACH_RUNTIME_URL;
  delete process.env.AGENT_REACH_REFRESH_TOKEN;
});

describe("host Reddit cookie refresh client", () => {
  it("calls the private maintenance endpoint with the refresh authority", async () => {
    process.env.AGENT_REACH_RUNTIME_URL = "http://127.0.0.1:9876/";
    process.env.AGENT_REACH_REFRESH_TOKEN = "refresh-token";
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(refreshRedditCookiesInRuntime()).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9876/maintenance/reddit-cookie-refresh",
      {
        method: "POST",
        headers: { authorization: "Bearer refresh-token" },
      },
    );
  });

  it("fails before making a request when refresh authority is unavailable", async () => {
    await expect(refreshRedditCookiesInRuntime()).rejects.toThrow(
      "refresh token is unavailable",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a failed maintenance response without treating it as success", async () => {
    process.env.AGENT_REACH_REFRESH_TOKEN = "refresh-token";
    fetchMock.mockResolvedValueOnce(
      new Response("refresh failed", { status: 503 }),
    );

    await expect(refreshRedditCookiesInRuntime()).rejects.toThrow(
      "refresh failed",
    );
  });
});
