import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildToolRuntimeArgs,
  executeToolRuntime,
} from "./tool-runtime-client.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  lstat: vi.fn(
    (await importOriginal<typeof import("node:fs/promises")>()).lstat,
  ),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

function containerExit(code: number, stdout: string, diagnostics: Buffer[]) {
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    child.stdin.once("finish", () => {
      for (const chunk of diagnostics) child.stderr.write(chunk);
      child.stderr.end();
      child.stdout.end(stdout);
      child.emit("close", code);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  });
}

const call = () => executeToolRuntime("arxiv-search", { query: "fixture" });

describe("Tool Runtime workspace mount", () => {
  it("rejects credential/workspace ownership mismatches rather than overriding the credential identity", async () => {
    vi.mocked(lstat).mockImplementation(async (path) => {
      const workspace = path === "/trusted/workspace";
      return {
        isDirectory: () => workspace,
        isFile: () => !workspace,
        isSymbolicLink: () => false,
        uid: workspace ? 1000 : 2000,
        gid: workspace ? 1000 : 2000,
      } as never;
    });
    try {
      await expect(
        buildToolRuntimeArgs(
          { capability: "x-search", args: { query: "q" } },
          "test-runtime",
          { root: "/trusted", workspace: "/trusted/workspace" },
        ),
      ).rejects.toThrow("workspace and credential owner must match");
    } finally {
      vi.mocked(lstat).mockRestore();
    }
  });
  it("binds only the trusted run workspace and requires one for git-clone", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "runtime-workspace-"));
    try {
      const args = await buildToolRuntimeArgs(
        {
          capability: "git-clone",
          args: { url: "https://github.com/a/b", destination: "repo" },
        },
        "test-runtime",
        { workspace },
      );
      expect(args).toContain(`type=bind,src=${workspace},dst=/workspace`);
      expect(args).not.toContain("type=bind,src=/other-group,dst=/workspace");
      await expect(
        buildToolRuntimeArgs(
          { capability: "git-clone", args: {} },
          "test-runtime",
        ),
      ).rejects.toThrow("trusted group workspace");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

describe("Reddit fetch state", () => {
  it("mounts only the cookie read-only, never the browser profile", async () => {
    vi.mocked(lstat).mockResolvedValue({
      isFile: () => true,
      isSymbolicLink: () => false,
      uid: 1000,
      gid: 1000,
    } as never);
    try {
      const args = await buildToolRuntimeArgs(
        {
          capability: "agent-reach",
          args: { url: "https://www.reddit.com/r/test.json" },
        },
        "test-runtime",
        { root: "/trusted" },
      );
      expect(args).toContain(
        "type=bind,src=/trusted/data/reddit-cookies.json,dst=/var/lib/reddit/reddit-cookies.json,readonly",
      );
      expect(args.join(" ")).not.toContain("reddit-browser-profile");
    } finally {
      vi.mocked(lstat).mockRestore();
    }
  });
});

describe("Tool Runtime host diagnostics", () => {
  it("removes staging left behind by a failed Runtime call", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "runtime-stage-"));
    vi.mocked(spawn).mockImplementationOnce((_command, args) => {
      const name = args[args.indexOf("--name") + 1];
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      child.stdin.once("finish", async () => {
        await mkdir(join(workspace, `.git-clone-${name}`));
        await writeFile(
          join(workspace, `.git-clone-${name}`, "partial"),
          "incomplete",
        );
        child.stdout.end(JSON.stringify({ error: "clone failed" }));
        child.stderr.end();
        child.emit("close", 0);
      });
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    try {
      await expect(
        executeToolRuntime(
          "git-clone",
          { url: "https://github.com/a/b", destination: "repo" },
          undefined,
          { workspace },
        ),
      ).rejects.toThrow("clone failed");
      expect(await readdir(workspace)).toEqual([]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
  it.each([
    [125, "", "failed to start or exited unexpectedly"],
    [0, "invalid JSON", "Invalid Tool Runtime response"],
    [0, JSON.stringify({ error: "capability failed" }), "capability failed"],
  ])("logs stderr on failure without adding it to the caller error (%i, %s)", async (code, stdout, message) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const diagnostic = "setpriv: private host path /fixture/private";
    containerExit(code, stdout, [Buffer.from(diagnostic)]);
    const error = await call().catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty("message", expect.stringContaining(message));
    expect(error).toHaveProperty(
      "message",
      expect.not.stringContaining(diagnostic),
    );
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(
        /^\[tool-runtime\] my-discord-agent-tool-.* stderr:$/,
      ),
      diagnostic,
    );
  });

  it("bounds retained stderr across chunks and drains excess output", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    containerExit(125, "", [
      Buffer.alloc(10 * 1024, "a"),
      Buffer.alloc(64 * 1024, "b"),
      Buffer.from("discarded tail"),
    ]);
    await expect(call()).rejects.toThrow("failed to start");
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("truncated at 16 KiB"),
      "a".repeat(10 * 1024) + "b".repeat(6 * 1024),
    );
  });

  it("does not log or return stderr for successful calls", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = { content: [{ type: "text", text: "[]" }], details: {} };
    containerExit(0, JSON.stringify({ result }), [
      Buffer.from("private diagnostic"),
    ]);
    await expect(call()).resolves.toEqual(result);
    expect(log).not.toHaveBeenCalled();
  });
});
