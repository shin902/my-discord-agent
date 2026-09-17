import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

    const arxivArgs = await buildToolRuntimeArgs(
      { capability: "arxiv-search", args: { query: "test" } },
      "arxiv-fixture",
      { root },
    );
    expect(arxivArgs.join(" ")).not.toContain("twitter-cookies");
  });

  it("mounts only the persistent profile and isolated output for maintenance", async () => {
    root = await mkdtemp(join(tmpdir(), "x-maintenance-runtime-"));
    const profile = join(root, "data/x-browser-profile");
    const output = join(root, "data/output");
    await mkdir(profile, { recursive: true });
    await mkdir(output);

    const args = await buildToolRuntimeArgs(
      { maintenance: "x-cookie-refresh" },
      "x-refresh-fixture",
      { root, xCookieOutputDir: output },
    );
    expect(args).toEqual(
      expect.arrayContaining([
        `type=bind,src=${profile},dst=/var/lib/twitter/profile`,
        `type=bind,src=${output},dst=/var/lib/twitter/output`,
      ]),
    );
    expect(args.join(" ")).not.toContain("data/twitter-cookies.json");
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
