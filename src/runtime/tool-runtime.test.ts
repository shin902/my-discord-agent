import { afterEach, describe, expect, it, vi } from "vitest";
import { agentReachTool } from "../tools/agent-reach.js";
import { arxivSearchTool } from "../tools/arxiv.js";
import { executeRuntimeRequest } from "./tool-runtime.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("one-shot Tool Runtime protocol", () => {
  it.each([
    null,
    [],
    { capability: "bash", args: { command: "echo unsafe" } },
    { capability: "list-emails", args: {} },
    { capability: "__proto__", args: {} },
    { capability: "arxiv-search", args: { query: 1 } },
    { capability: "arxiv-search", args: { query: "q" }, image: "other" },
    { maintenance: "shell" },
    { maintenance: "x-cookie-refresh" },
  ])("rejects unregistered operations or malformed requests: %j", async (request) => {
    expect(await executeRuntimeRequest(request)).toHaveProperty("error");
  });

  it("returns raw large results without Runtime paths or externalization", async () => {
    const text = "retrieved result\n".repeat(20_000);
    const result = {
      content: [{ type: "text" as const, text }],
      details: { service: "web" },
    };
    const execute = vi
      .spyOn(agentReachTool, "execute")
      .mockResolvedValue(result);
    expect(
      await executeRuntimeRequest({
        capability: "agent-reach",
        args: { url: "https://example.com" },
      }),
    ).toEqual({ result });
    expect(execute).toHaveBeenCalledExactlyOnceWith("tool-runtime", {
      url: "https://example.com",
    });
  });

  it("executes already-materialized arguments unchanged", async () => {
    const args = { query: "q", max_results: 50, sort: "relevance" };
    const execute = vi
      .spyOn(arxivSearchTool, "execute")
      .mockResolvedValue({ content: [], details: {} });
    await executeRuntimeRequest({ capability: "arxiv-search", args });
    expect(execute.mock.calls[0][1]).toBe(args);
  });

  it("does not expose Reddit maintenance as a capability or protocol operation", async () => {
    expect(
      await executeRuntimeRequest({
        capability: "reddit-cookie-refresh",
        args: {},
      }),
    ).toHaveProperty("error");
    expect(
      await executeRuntimeRequest({ maintenance: "reddit-cookie-refresh" }),
    ).toHaveProperty("error");
  });
});
