import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { spawn } from "node:child_process";

const mockSpawn = vi.mocked(spawn);

function createMockChild() {
  return Object.assign(new EventEmitter() as ChildProcess, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
  });
}

const PROXY_CREDS = JSON.stringify([
  { provider: "github-git", baseUrl: "http://proxy.test/github-git" },
]);

function mockSuccess(stdout = "", stderr = "") {
  mockSpawn.mockImplementation(() => {
    const child = createMockChild();
    queueMicrotask(() => {
      if (stdout) child.stdout.emit("data", stdout);
      if (stderr) child.stderr.emit("data", stderr);
      child.emit("close", 0, null);
    });
    return child;
  });
}

function mockFailure(err: Error & { stderr?: string }) {
  mockSpawn.mockImplementation(() => {
    const child = createMockChild();
    queueMicrotask(() => {
      if (err.stderr) child.stderr.emit("data", err.stderr);
      child.emit("close", 1, null);
    });
    return child;
  });
}

function firstText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || first.text == null) {
    throw new Error("Expected text content");
  }
  return first.text;
}

describe("clone-repository", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = { ...originalEnv, CREDENTIAL_PROXY_JSON: PROXY_CREDS };
  });

  afterEach(async () => {
    process.env = originalEnv;
    await Promise.all([
      rm("/tmp/r", { force: true, recursive: true }),
      rm("/tmp/my-dir", { force: true, recursive: true }),
    ]);
  });

  it("プロキシ経由のURLでgit cloneを実行する", async () => {
    mockSuccess();
    const { cloneRepositoryTool } = await import("./git.js");
    await cloneRepositoryTool.execute("id", { owner: "o", repo: "r" });

    const args = mockSpawn.mock.calls[0];
    expect(args[0]).toBe("git");
    expect(args[1]).toEqual([
      "clone",
      "http://proxy.test/github-git/o/r.git",
      "/proc/self/fd/3",
    ]);
    expect((args[2] as { stdio: unknown[] }).stdio[3]).toEqual(
      expect.any(Number),
    );
  });

  it("depth を指定すると shallow clone の引数を追加する", async () => {
    mockSuccess();
    const { cloneRepositoryTool } = await import("./git.js");
    await cloneRepositoryTool.execute("id", {
      owner: "o",
      repo: "r",
      depth: 5,
    });

    expect(mockSpawn.mock.calls[0]?.[1]).toEqual([
      "clone",
      "--depth",
      "5",
      "http://proxy.test/github-git/o/r.git",
      "/proc/self/fd/3",
    ]);
  });

  it("directory の相対パスを /tmp 基準の clone 先として受け付ける", async () => {
    mockSuccess();
    const { cloneRepositoryTool } = await import("./git.js");
    await cloneRepositoryTool.execute("id", {
      owner: "o",
      repo: "r",
      directory: "my-dir",
    });

    expect(mockSpawn.mock.calls[0]?.[1]).toContain("/proc/self/fd/3");
  });

  it("directory が /tmp 外へ出る親相対パスなら例外", async () => {
    const { cloneRepositoryTool } = await import("./git.js");
    await expect(
      cloneRepositoryTool.execute("id", {
        owner: "o",
        repo: "r",
        directory: "../escape",
      }),
    ).rejects.toThrow("clone 先が /tmp 外に出ることは許可されていません");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("directory が絶対パスなら例外", async () => {
    const { cloneRepositoryTool } = await import("./git.js");
    await expect(
      cloneRepositoryTool.execute("id", {
        owner: "o",
        repo: "r",
        directory: "/tmp/clone",
      }),
    ).rejects.toThrow("/tmp 配下の相対パスで指定してください");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("directory が /tmp 内の symlink 経由で外へ出るなら例外", async () => {
    const testDir = await mkdtemp("/tmp/clone-repository-symlink-");
    const linkPath = join(testDir, "link");
    const directory = relative("/tmp", join(linkPath, "repo"));
    try {
      await symlink("/workspace", linkPath);
      const { cloneRepositoryTool } = await import("./git.js");
      await expect(
        cloneRepositoryTool.execute("id", {
          owner: "o",
          repo: "r",
          directory,
        }),
      ).rejects.toThrow("clone 先までの既存パスに symlink が含まれています");
      expect(mockSpawn).not.toHaveBeenCalled();
    } finally {
      await rm(testDir, { force: true, recursive: true });
    }
  });

  it("clone 開始後にパスの祖先が置き換えられても fd の先へ書き込む", async () => {
    const testDir = await mkdtemp("/tmp/clone-repository-race-");
    const parent = join(testDir, "parent");
    const movedParent = join(testDir, "moved-parent");
    const outside = join(testDir, "outside");
    const directory = relative("/tmp", join(parent, "repo"));
    mkdirSync(outside);

    mockSpawn.mockImplementation((_file, _args, options) => {
      const stdio = (options as { stdio: unknown[] }).stdio;
      const destinationFd = stdio[3];
      if (typeof destinationFd !== "number") {
        throw new Error("clone destination fd が渡されていません");
      }
      renameSync(parent, movedParent);
      symlinkSync(outside, parent);
      writeFileSync(
        `/proc/self/fd/${destinationFd}/race-marker`,
        "opened-directory",
      );

      const child = createMockChild();
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });

    try {
      const { cloneRepositoryTool } = await import("./git.js");
      await cloneRepositoryTool.execute("id", {
        owner: "o",
        repo: "r",
        directory,
      });
      expect(
        readFileSync(join(movedParent, "repo", "race-marker"), "utf8"),
      ).toBe("opened-directory");
      expect(existsSync(join(outside, "race-marker"))).toBe(false);
    } finally {
      await rm(testDir, { force: true, recursive: true });
    }
  });

  it("成功時に clone 先を返す", async () => {
    mockSuccess();
    const { cloneRepositoryTool } = await import("./git.js");
    const result = await cloneRepositoryTool.execute("id", {
      owner: "o",
      repo: "r",
    });
    expect(firstText(result)).toContain("o/r");
    expect(firstText(result)).toContain("/tmp/r");
    expect(firstText(result)).toContain("全履歴");
    expect(result.details).toEqual({
      owner: "o",
      repo: "r",
      directory: "/tmp/r",
      depth: null,
    });
  });

  it("owner/repo に不正な文字が含まれると例外", async () => {
    const { cloneRepositoryTool } = await import("./git.js");
    await expect(
      cloneRepositoryTool.execute("id", { owner: "o/../x", repo: "r" }),
    ).rejects.toThrow("無効なowner");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("depth が正の整数でなければ例外", async () => {
    const { cloneRepositoryTool } = await import("./git.js");
    await expect(
      cloneRepositoryTool.execute("id", {
        owner: "o",
        repo: "r",
        depth: 0,
      }),
    ).rejects.toThrow("depth は正の整数で指定してください");
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("git clone失敗時はstderrを含む例外を投げる", async () => {
    mockFailure(
      Object.assign(new Error("failed"), {
        stderr: "fatal: repository not found",
      }),
    );
    const { cloneRepositoryTool } = await import("./git.js");
    await expect(
      cloneRepositoryTool.execute("id", { owner: "o", repo: "r" }),
    ).rejects.toThrow("fatal: repository not found");
  });

  it("github-git プロバイダーが CREDENTIAL_PROXY_JSON にない場合は例外", async () => {
    process.env.CREDENTIAL_PROXY_JSON = JSON.stringify([
      { provider: "github", baseUrl: "http://proxy.test/github" },
    ]);
    const { cloneRepositoryTool } = await import("./git.js");
    await expect(
      cloneRepositoryTool.execute("id", { owner: "o", repo: "r" }),
    ).rejects.toThrow(
      "github-git プロバイダーが CREDENTIAL_PROXY_JSON に見つかりません",
    );
  });
});
