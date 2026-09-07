import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshRedditCookies } from "../proxy/reddit-cookie-refresh.js";
import { agentReachTool } from "../tools/agent-reach.js";
import { arxivSearchTool } from "../tools/arxiv.js";
import { executeRuntimeRequest } from "./tool-runtime.js";

vi.mock("../proxy/reddit-cookie-refresh.js", () => ({
  refreshRedditCookies: vi.fn(),
}));
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
  ])("rejects unregistered operations or malformed requests: %j", async (request) => {
    expect(await executeRuntimeRequest(request)).toHaveProperty("error");
    expect(refreshRedditCookies).not.toHaveBeenCalled();
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
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "tool-runtime",
      { url: "https://example.com" },
      expect.any(AbortSignal),
    );
  });

  it("executes already-materialized arguments unchanged", async () => {
    const args = { query: "q", max_results: 50, sort: "relevance" };
    const execute = vi
      .spyOn(arxivSearchTool, "execute")
      .mockResolvedValue({ content: [], details: {} });
    await executeRuntimeRequest({ capability: "arxiv-search", args });
    expect(execute.mock.calls[0][1]).toBe(args);
  });

  it("keeps maintenance separate from capability dispatch and suppresses browser diagnostics", async () => {
    expect(
      await executeRuntimeRequest({
        capability: "reddit-cookie-refresh",
        args: {},
      }),
    ).toHaveProperty("error");
    expect(
      await executeRuntimeRequest({ maintenance: "reddit-cookie-refresh" }),
    ).toHaveProperty("error");
    vi.stubEnv("REDDIT_PROFILE_DIR", "/fixture/profile");
    vi.stubEnv("REDDIT_COOKIE_FILE", "/fixture/cookies.json");
    vi.mocked(refreshRedditCookies).mockRejectedValueOnce(
      new Error("private browser state /fixture/profile"),
    );
    expect(
      await executeRuntimeRequest({ maintenance: "reddit-cookie-refresh" }),
    ).toEqual({
      error:
        "Reddit cookie refresh failed; check login and Runtime diagnostics",
    });
    expect(refreshRedditCookies).toHaveBeenCalledExactlyOnceWith({
      profileDir: "/fixture/profile",
      cookieFile: "/fixture/cookies.json",
    });
  });
});
