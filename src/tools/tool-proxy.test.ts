import { readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_OUTPUT_CHAR_LIMIT } from "./output.js";
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

  it("externalizes oversized host results in the sandbox", async () => {
    const text = "host-result\n".repeat(5_000);
    expect(text.length).toBeGreaterThan(TOOL_OUTPUT_CHAR_LIMIT);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          result: {
            content: [{ type: "text", text }],
            details: { source: "host" },
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
    const details = result.details as {
      fullOutputPath: string;
      truncated: boolean;
    };

    try {
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("ツール出力が大きいため"),
      });
      expect(details.truncated).toBe(true);
      expect(await readFile(details.fullOutputPath, "utf8")).toBe(text);
    } finally {
      await rm(dirname(details.fullOutputPath), {
        recursive: true,
        force: true,
      });
    }
  });

  it("fails closed when no endpoint is supplied", async () => {
    const tool = createToolProxyTool(getCurrentWeatherTool);
    await expect(tool.execute("call-1", { location: "東京" })).rejects.toThrow(
      "Tool Proxy endpoint is unavailable",
    );
  });
});
