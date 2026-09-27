import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  realpath: vi.fn(async () => "/workspace"),
  mkdir: vi.fn(async () => undefined),
  rename: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  lstat: vi.fn(async () => {
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  }),
}));

import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { cloneGitRepository } from "./git-clone.js";

const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
const stageName =
  ".git-clone-my-discord-agent-tool-00000000-0000-4000-8000-000000000000";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(realpath).mockResolvedValue("/workspace");
  vi.mocked(lstat).mockRejectedValue(
    Object.assign(new Error("missing"), { code: "ENOENT" }),
  );
});

describe("git-clone", () => {
  it("clones a public HTTPS repository into the workspace without forwarding credentials", async () => {
    expect(
      await cloneGitRepository(
        "https://github.com/example/repo.git",
        "repo",
        run as never,
        stageName,
      ),
    ).toBe("repo");
    expect(run).toHaveBeenCalledWith(
      "git",
      [
        "clone",
        "--",
        "https://github.com/example/repo.git",
        `/workspace/${stageName}/repo`,
      ],
      expect.objectContaining({
        cwd: "/workspace",
        env: expect.objectContaining({ GIT_TERMINAL_PROMPT: "0" }),
      }),
    );
    expect(rename).toHaveBeenCalledWith(
      `/workspace/${stageName}/repo`,
      "/workspace/repo",
    );
  });

  it.each([
    "../outside",
    "/tmp/outside",
    "sub/../outside",
    "",
    "a\\..\\b",
  ])("rejects destination %j", async (destination) => {
    await expect(
      cloneGitRepository(
        "https://github.com/example/repo",
        destination,
        run as never,
      ),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    "http://github.com/a/b",
    "https://user:token@github.com/a/b",
    "file:///tmp/repo",
    "https://github.com/",
    "https://github.com/a/b?token=secret",
    "https://localhost/a/b",
    "https://127.0.0.1/a/b",
    "https:\\github.com\\a\\b",
  ])("rejects URL %j", async (url) => {
    await expect(
      cloneGitRepository(url, "repo", run as never),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("removes a partial checkout after clone failure", async () => {
    run.mockRejectedValueOnce(new Error("network failed"));
    await expect(
      cloneGitRepository(
        "https://github.com/a/b",
        "repo",
        run as never,
        stageName,
      ),
    ).rejects.toThrow("network failed");
    expect(mkdir).toHaveBeenCalledWith(`/workspace/${stageName}`, {
      mode: 0o700,
    });
    expect(rm).toHaveBeenCalledWith(`/workspace/${stageName}`, {
      recursive: true,
      force: true,
    });
    expect(rename).not.toHaveBeenCalled();
  });

  it("rejects existing destinations and symlinked parents", async () => {
    vi.mocked(lstat).mockResolvedValueOnce({} as never);
    await expect(
      cloneGitRepository("https://github.com/a/b", "repo", run as never),
    ).rejects.toThrow("already exists");
    vi.mocked(realpath).mockResolvedValueOnce("/elsewhere");
    await expect(
      cloneGitRepository("https://github.com/a/b", "sub/repo", run as never),
    ).rejects.toThrow("inside workspace");
    expect(run).not.toHaveBeenCalled();
  });
});
