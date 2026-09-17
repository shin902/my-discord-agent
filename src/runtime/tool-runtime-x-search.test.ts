import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildToolRuntimeArgs } from "./tool-runtime-client.js";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("x-search Runtime state", () => {
  it("mounts canonical state read-only only for x-search", async () => {
    root = await mkdtemp(join(tmpdir(), "x-search-runtime-"));
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(join(root as string, "data")),
    );
    const state = join(root, "data/twitter-cookies.json");
    await writeFile(state, "fixture");

    const stat = await lstat(state);
    const xArgs = await buildToolRuntimeArgs(
      { capability: "x-search", args: { query: "test" } },
      "x-search-fixture",
      { root },
    );
    expect(xArgs).toEqual(
      expect.arrayContaining([
        `TOOL_RUNTIME_UID=${stat.uid}`,
        `TOOL_RUNTIME_GID=${stat.gid}`,
        `type=bind,src=${state},dst=/var/lib/twitter/twitter-cookies.json,readonly`,
      ]),
    );

    expect(xArgs.filter((arg) => arg.startsWith("type=bind,"))).toEqual([
      `type=bind,src=${state},dst=/var/lib/twitter/twitter-cookies.json,readonly`,
    ]);
    expect(xArgs.join(" ")).not.toMatch(
      /x-browser-profile|X_PROFILE_DIR|X_COOKIE_FILE|\/var\/lib\/twitter\/(profile|output)/,
    );

    const arxivArgs = await buildToolRuntimeArgs(
      { capability: "arxiv-search", args: { query: "test" } },
      "arxiv-fixture",
      { root },
    );
    expect(arxivArgs.join(" ")).not.toContain("twitter-cookies");
  });

  it("fails closed when state is missing", async () => {
    root = await mkdtemp(join(tmpdir(), "x-search-runtime-"));
    await expect(
      buildToolRuntimeArgs(
        { capability: "x-search", args: { query: "test" } },
        "x-search-fixture",
        { root },
      ),
    ).rejects.toThrow("X search state is unavailable or invalid");
  });
});
