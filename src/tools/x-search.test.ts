import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

const { executeXSearch, xSearchTool } = await import("./x-search.js");

afterEach(() => vi.resetAllMocks());

describe("x-search", () => {
  it("passes query as argv and credentials only through the child environment", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(
      JSON.stringify({ auth_token: "secret-auth", ct0: "secret-ct0" }),
    );
    const run = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({ ok: true, data: [{ id: "123" }] }),
      stderr: "",
    });

    await expect(
      executeXSearch(
        { query: "Strix Halo lang:ja", limit: 5, mode: "latest" },
        undefined,
        run,
      ),
    ).resolves.toEqual([{ id: "123" }]);
    expect(run).toHaveBeenCalledWith(
      "twitter",
      [
        "search",
        "Strix Halo lang:ja",
        "--type",
        "Latest",
        "--max",
        "5",
        "--json",
      ],
      expect.objectContaining({
        env: expect.objectContaining({
          TWITTER_AUTH_TOKEN: "secret-auth",
          TWITTER_CT0: "secret-ct0",
        }),
      }),
    );
  });

  it("does not expose credentials or upstream output on failure", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(
      JSON.stringify({ auth_token: "secret-auth", ct0: "secret-ct0" }),
    );
    const run = vi
      .fn()
      .mockRejectedValue(new Error("raw authenticated response: secret-auth"));

    await expect(
      executeXSearch({ query: "test" }, undefined, run),
    ).rejects.toThrow(
      "X search failed; credentials may be expired, rate limited, or the upstream API may have changed",
    );
  });

  it("exposes only the bounded top/latest native schema", () => {
    expect(xSearchTool.parameters).toMatchObject({
      properties: {
        query: { minLength: 1, maxLength: 500 },
        limit: { minimum: 1, maximum: 50 },
      },
    });
  });
});
