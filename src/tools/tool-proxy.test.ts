import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolProxyTool } from "./tool-proxy.js";
import { getCurrentWeatherTool } from "./weather.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createToolProxyTool", () => {
  it("sends the capability and opaque bearer token to the RPC endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          result: {
            content: [{ type: "text", text: "weather result" }],
            details: { location: "東京" },
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tool = createToolProxyTool(getCurrentWeatherTool, {
      url: "http://host.docker.internal:1234/__tool-proxy/rpc",
      token: "opaque-token",
    });

    const result = await tool.execute("call-1", { location: "東京" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://host.docker.internal:1234/__tool-proxy/rpc",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer opaque-token",
        },
        body: JSON.stringify({
          capability: "get-current-weather",
          args: { location: "東京" },
        }),
      }),
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "weather result" }],
      details: { location: "東京" },
    });
  });

  it("fails closed when no endpoint is supplied", async () => {
    const tool = createToolProxyTool(getCurrentWeatherTool);
    await expect(tool.execute("call-1", { location: "東京" })).rejects.toThrow(
      "Tool Proxy endpoint is unavailable",
    );
  });
});
