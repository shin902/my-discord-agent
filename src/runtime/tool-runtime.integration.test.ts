import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  buildToolRuntimeArgs,
  cleanupToolRuntimes,
  executeToolRuntime,
  refreshRedditCookiesInRuntime,
  stopToolRuntimes,
  toolRuntimeLabel,
} from "./tool-runtime-client.js";
import { createToolRuntimeFixture } from "./tool-runtime-fixture.js";

const execFileAsync = promisify(execFile);
const baseImage = process.env.TOOL_RUNTIME_TEST_IMAGE;

describe.skipIf(!baseImage)("disposable Tool Runtime Docker boundary", () => {
  let fixture: Awaited<ReturnType<typeof createToolRuntimeFixture>>;
  beforeAll(async () => {
    fixture = await createToolRuntimeFixture(baseImage as string);
  }, 120_000);
  afterEach(async () => {
    vi.useRealTimers();
    await stopToolRuntimes();
    await cleanupToolRuntimes(fixture.options);
  });
  afterAll(async () => {
    await fixture?.dispose();
  }, 30_000);

  async function containers(): Promise<string[]> {
    const { stdout } = await execFileAsync("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=${toolRuntimeLabel(fixture.options.root)}`,
    ]);
    return stdout.trim().split(/\s+/).filter(Boolean);
  }
  async function waitUntil<T>(read: () => Promise<T | undefined>): Promise<T> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = await read();
      if (value !== undefined) return value;
      await delay(20);
    }
    throw new Error("Timed out waiting for fixture container");
  }
  async function waitForChild(excluded: string[] = []): Promise<string> {
    return waitUntil(async () => {
      for (const id of await containers()) {
        if (excluded.includes(id)) continue;
        try {
          await execFileAsync("docker", [
            "exec",
            id,
            "test",
            "-f",
            "/tmp/tool-runtime-child.pid",
          ]);
          return id;
        } catch {
          /* wait for the real yt-dlp descendant */
        }
      }
    });
  }
  async function expectRemoved(id?: string): Promise<void> {
    await waitUntil(async () => {
      const ids = await containers();
      return (id ? !ids.includes(id) : ids.length === 0) ? true : undefined;
    });
  }
  function startHang(signal?: AbortSignal) {
    return executeToolRuntime(
      "agent-reach",
      { url: "https://youtube.com/watch?v=hang" },
      signal,
      fixture.options,
    ).then(
      (result) => ({ result }),
      (error) => ({ error: error as Error }),
    );
  }

  it("uses fixed launch conditions and starts non-Reddit calls without state", async () => {
    const args = await buildToolRuntimeArgs(
      { capability: "arxiv-search", args: { query: "q" } },
      "fixture-name",
      { ...fixture.options, root: join(fixture.options.root, "absent-state") },
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--rm",
        "--pull=never",
        "-i",
        "--name",
        "fixture-name",
        "--cap-drop=ALL",
        "--cap-add=NET_ADMIN",
        "--dns=1.1.1.1",
        "--dns=8.8.8.8",
        "--security-opt=no-new-privileges:true",
      ]),
    );
    expect(args).not.toContain("--mount");
    await expect(
      executeToolRuntime(
        "agent-reach",
        { url: "https://www.reddit.com/search.json?q=fixture" },
        undefined,
        {
          ...fixture.options,
          root: join(fixture.options.root, "absent-state"),
        },
      ),
    ).rejects.toThrow("Reddit state is unavailable");
    const result = await executeToolRuntime(
      "hackernews-search",
      { topic: "identity" },
      undefined,
      { ...fixture.options, root: join(fixture.options.root, "absent-state") },
    );
    expect(result.content[0]).toMatchObject({
      text: expect.stringMatching(/uid=1000 CapEff:\s+0000000000000000/),
    });
  }, 10_000);

  it("dispatches normalized arXiv, HN and GitHub results through real one-shot containers", async () => {
    const results = await Promise.all([
      executeToolRuntime(
        "arxiv-search",
        { query: "q", max_results: 10, sort: "relevance" },
        undefined,
        fixture.options,
      ),
      executeToolRuntime(
        "arxiv-survey",
        { queries: ["q", "other"], max_results: 30, sort: "submitted" },
        undefined,
        fixture.options,
      ),
      executeToolRuntime(
        "hackernews-search",
        { topic: "q" },
        undefined,
        fixture.options,
      ),
      executeToolRuntime(
        "github-recent-search",
        { topic: "q" },
        undefined,
        fixture.options,
      ),
    ]);
    const first = results[0].content[0];
    if (first.type !== "text") throw new Error("no text");
    expect(JSON.parse(first.text)[0]).toMatchObject({
      id: "2608.12345",
      version: 2,
      title: "Runtime boundary",
      updated_at: "2026-08-20T03:00:00.000Z",
    });
    expect(results[1].content).toEqual(results[0].content);
    expect(results[2].content[0]).toMatchObject({
      text: expect.stringContaining("[42pt] Runtime HN fixture"),
    });
    expect(results[3].content[0]).toMatchObject({
      text: expect.stringContaining("[9👍] Runtime issue fixture"),
    });
    await expectRemoved();
  }, 15_000);

  it("removes successful and failed calls while returning the complete large result", async () => {
    const result = await executeToolRuntime(
      "agent-reach",
      { url: "https://example.com/large" },
      undefined,
      fixture.options,
    );
    expect(result.content[0]).toEqual({
      type: "text",
      text: "artifact-line\n".repeat(20_000),
    });
    expect(result.details).not.toHaveProperty("fullOutputPath");
    await expectRemoved();
    await expect(
      executeToolRuntime(
        "agent-reach",
        { url: "https://example.com/failure" },
        undefined,
        fixture.options,
      ),
    ).rejects.toThrow("fixture fetch failed");
    await expectRemoved();
  }, 10_000);

  it("kills only the aborted call and all its real descendants", async () => {
    const first = new AbortController();
    const second = new AbortController();
    const firstPending = startHang(first.signal);
    const firstId = await waitForChild();
    const { stdout: processes } = await execFileAsync("docker", [
      "top",
      firstId,
      "-eo",
      "pid,args",
    ]);
    const childLine = processes
      .split("\n")
      .find((line) => line.includes("setInterval"));
    expect(childLine).toBeDefined();
    const childPid = Number(childLine?.trim().split(/\s+/)[0]);
    const secondPending = startHang(second.signal);
    const secondId = await waitForChild([firstId]);
    expect(secondId).not.toBe(firstId);
    first.abort();
    expect(await firstPending).toHaveProperty(
      "error.message",
      "Tool Runtime aborted",
    );
    await expectRemoved(firstId);
    await waitUntil(async () => {
      try {
        process.kill(childPid, 0);
        return undefined;
      } catch {
        return true;
      }
    });
    expect(await containers()).toContain(secondId);
    second.abort();
    await secondPending;
    await expectRemoved();
  }, 15_000);

  it("host timeout and shutdown terminate the same named container boundary", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = startHang();
    const id = await waitForChild();
    await vi.advanceTimersByTimeAsync(120_000);
    vi.useRealTimers();
    expect(await pending).toHaveProperty(
      "error.message",
      "Tool Runtime timed out",
    );
    await expectRemoved(id);
    const shutdownPending = startHang();
    await waitForChild();
    await stopToolRuntimes();
    expect(await shutdownPending).toHaveProperty(
      "error.message",
      "Tool Runtime aborted",
    );
    await expectRemoved();
  }, 15_000);

  it("retains fixed Reddit state across fetch and maintenance calls without exposing Cookie", async () => {
    const cookiePath = join(fixture.options.root, "data/reddit-cookies.json");
    const before = await readFile(cookiePath, "utf8");
    const args = await buildToolRuntimeArgs(
      {
        capability: "agent-reach",
        args: { url: "https://www.reddit.com/search.json?q=fixture" },
      },
      "fixture-reddit",
      fixture.options,
    );
    expect(
      args.some((arg) => arg.includes("reddit-cookies.json,readonly")),
    ).toBe(true);
    expect(args.some((arg) => arg.includes("reddit-browser-profile"))).toBe(
      false,
    );
    const result = await executeToolRuntime(
      "agent-reach",
      { url: "https://www.reddit.com/search.json?q=fixture" },
      undefined,
      fixture.options,
    );
    expect(JSON.stringify(result)).toContain("Runtime Reddit fixture");
    expect(JSON.stringify(result)).not.toContain("fixture=only");
    expect(await readFile(cookiePath, "utf8")).toBe(before);
    await refreshRedditCookiesInRuntime(fixture.options);
    expect(
      await readFile(
        join(
          fixture.options.root,
          "data/reddit-browser-profile/fixture-refreshed",
        ),
        "utf8",
      ),
    ).toBe("refreshed");
    expect(JSON.parse(await readFile(cookiePath, "utf8"))).toMatchObject({
      cookieHeader: "fixture=only",
    });
    await expectRemoved();
  }, 15_000);

  it("startup cleanup removes only this checkout's Tool Runtime label", async () => {
    const names = [0, 1, 2].map(() => `issue402-cleanup-${randomUUID()}`);
    const labels = [
      toolRuntimeLabel(fixture.options.root),
      toolRuntimeLabel(`${fixture.options.root}/other`),
      "my-discord-agent.runner=true",
    ];
    try {
      for (let index = 0; index < names.length; index++)
        await execFileAsync("docker", [
          "run",
          "--rm",
          "-d",
          "--name",
          names[index],
          "--label",
          labels[index],
          "--entrypoint",
          "node",
          fixture.options.image,
          "-e",
          "setInterval(() => {}, 1000)",
        ]);
      await cleanupToolRuntimes(fixture.options);
      await expect(
        execFileAsync("docker", ["inspect", names[0]]),
      ).rejects.toBeDefined();
      for (const name of names.slice(1))
        expect(
          (
            await execFileAsync("docker", [
              "inspect",
              "--format",
              "{{.State.Running}}",
              name,
            ])
          ).stdout.trim(),
        ).toBe("true");
    } finally {
      await Promise.allSettled(
        names.map((name) => execFileAsync("docker", ["rm", "-f", name])),
      );
    }
  }, 15_000);
});
