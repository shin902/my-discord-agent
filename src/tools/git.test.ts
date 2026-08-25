import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

import { execFile } from "node:child_process";

const mockExecFile = vi.mocked(execFile);

const PROXY_CREDS = JSON.stringify([
  { provider: "github-git", baseUrl: "http://proxy.test/github-git" },
]);

function mockSuccess(stdout = "", stderr = "") {
  mockExecFile.mockImplementation((..._args: unknown[]) => {
    const cb = _args[_args.length - 1] as (
      err: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    cb(null, stdout, stderr);
    return {} as ChildProcess;
  });
}

function mockFailure(err: Error & { stderr?: string }) {
  mockExecFile.mockImplementation((..._args: unknown[]) => {
    const cb = _args[_args.length - 1] as (
      err: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    cb(err, "", err.stderr ?? "");
    return {} as ChildProcess;
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

  afterEach(() => {
    process.env = originalEnv;
  });

  it("プロキシ経由のURLでgit cloneを実行する", async () => {
    mockSuccess();
    const { cloneRepositoryTool } = await import("./git.js");
    await cloneRepositoryTool.execute("id", { owner: "o", repo: "r" });

    const args = mockExecFile.mock.calls[0];
    expect(args[0]).toBe("git");
    expect(args[1]).toEqual([
      "clone",
      "http://proxy.test/github-git/o/r.git",
      "/tmp/r",
    ]);
  });

  it("depth を指定すると shallow clone の引数を追加する", async () => {
    mockSuccess();
    const { cloneRepositoryTool } = await import("./git.js");
    await cloneRepositoryTool.execute("id", {
      owner: "o",
      repo: "r",
      depth: 5,
    });

    expect(mockExecFile.mock.calls[0]?.[1]).toEqual([
      "clone",
      "--depth",
      "5",
      "http://proxy.test/github-git/o/r.git",
      "/tmp/r",
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

    expect(mockExecFile.mock.calls[0]?.[1]).toContain("/tmp/my-dir");
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
    expect(mockExecFile).not.toHaveBeenCalled();
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
    expect(mockExecFile).not.toHaveBeenCalled();
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
      expect(mockExecFile).not.toHaveBeenCalled();
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
    expect(mockExecFile).not.toHaveBeenCalled();
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
    expect(mockExecFile).not.toHaveBeenCalled();
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
