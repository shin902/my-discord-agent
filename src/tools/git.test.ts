import type { ChildProcess } from "node:child_process";
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

describe("clone_repository", () => {
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
      "--depth",
      "1",
      "http://proxy.test/github-git/o/r.git",
      "/workspace/r",
    ]);
  });

  it("directory を指定すると clone 先が変わる", async () => {
    mockSuccess();
    const { cloneRepositoryTool } = await import("./git.js");
    await cloneRepositoryTool.execute("id", {
      owner: "o",
      repo: "r",
      directory: "my-dir",
    });

    const args = mockExecFile.mock.calls[0];
    expect(args[1]).toContain("/workspace/my-dir");
  });

  it("成功時に clone 先を返す", async () => {
    mockSuccess();
    const { cloneRepositoryTool } = await import("./git.js");
    const result = await cloneRepositoryTool.execute("id", {
      owner: "o",
      repo: "r",
    });
    expect(firstText(result)).toContain("o/r");
    expect(firstText(result)).toContain("/workspace/r");
  });

  it("owner/repo に不正な文字が含まれると例外", async () => {
    const { cloneRepositoryTool } = await import("./git.js");
    await expect(
      cloneRepositoryTool.execute("id", { owner: "o/../x", repo: "r" }),
    ).rejects.toThrow("無効なowner");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("directory が絶対パスだと例外", async () => {
    const { cloneRepositoryTool } = await import("./git.js");
    await expect(
      cloneRepositoryTool.execute("id", {
        owner: "o",
        repo: "r",
        directory: "/etc/passwd",
      }),
    ).rejects.toThrow("絶対パスは指定できません");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("directory が .. でワークスペース外に出ようとすると例外", async () => {
    const { cloneRepositoryTool } = await import("./git.js");
    await expect(
      cloneRepositoryTool.execute("id", {
        owner: "o",
        repo: "r",
        directory: "../escape",
      }),
    ).rejects.toThrow("ワークスペース外に出ることは許可されていません");
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
