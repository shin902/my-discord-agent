import { spawn } from "node:child_process";
import { O_DIRECTORY, O_NOFOLLOW, O_RDONLY } from "node:constants";
import { lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import { assertValidRepoPart } from "./github.js";
import { assertNoParentTraversal } from "./path-safety.js";
import { resolveProxyBaseUrl } from "./proxy-url.js";

const WORKSPACE = "/workspace";
const CLONE_ROOT = "/tmp";
const CLONE_TIMEOUT_MS = 120_000;

function resolveCloneDir(repo: string, directory?: string): string {
  const raw = directory?.trim() || repo;
  if (isAbsolute(raw)) {
    throw new Error(
      `clone 先は /tmp 配下の相対パスで指定してください (${raw})`,
    );
  }

  const normalized = normalize(raw);
  assertNoParentTraversal(
    normalized,
    raw,
    "アクセス拒否: clone 先が /tmp 外に出ることは許可されていません",
  );
  return resolve(CLONE_ROOT, normalized);
}

const DIRECTORY_OPEN_FLAGS = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
const CLONE_DESTINATION_FD = 3;
const MAX_CLONE_OUTPUT_BYTES = 1024 * 1024;

function symlinkInCloneDestinationError(path: string): Error {
  return new Error(
    `アクセス拒否: clone 先までの既存パスに symlink が含まれています (${path})`,
  );
}

async function openDirectoryWithoutSymlink(path: string): Promise<FileHandle> {
  try {
    return await open(path, DIRECTORY_OPEN_FLAGS);
  } catch (err) {
    // O_NOFOLLOW rejects a raced symlink. lstat is only used to preserve the
    // tool's stable error for that case; the opened parent fd still anchors
    // this lookup to /tmp rather than to a path that can be redirected.
    try {
      if ((await lstat(path)).isSymbolicLink()) {
        throw symlinkInCloneDestinationError(path);
      }
    } catch (checkErr) {
      if (
        checkErr instanceof Error &&
        checkErr.message.startsWith("アクセス拒否: clone 先までの既存パス")
      ) {
        throw checkErr;
      }
    }
    throw err;
  }
}

async function openSecureCloneDestination(
  destination: string,
): Promise<FileHandle> {
  let current = await open(CLONE_ROOT, DIRECTORY_OPEN_FLAGS);
  try {
    const parts = relative(CLONE_ROOT, destination)
      .split(sep)
      .filter((part) => part.length > 0);

    for (const part of parts) {
      const child = `/proc/self/fd/${current.fd}/${part}`;
      try {
        await mkdir(child);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }

      const next = await openDirectoryWithoutSymlink(child);
      const previous = current;
      current = next;
      await previous.close();
    }

    return current;
  } catch (err) {
    await current.close().catch(() => {});
    throw err;
  }
}

function runGitClone(args: string[], destination: FileHandle): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("git", args, {
      cwd: WORKSPACE,
      timeout: CLONE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe", destination.fd],
    });

    let stderr = "";
    let outputBytes = 0;
    let outputLimitExceeded = false;
    let settled = false;

    const recordOutput = (chunk: string | Buffer, isStderr: boolean) => {
      outputBytes += Buffer.byteLength(chunk);
      if (isStderr) stderr += chunk.toString();
      if (outputBytes > MAX_CLONE_OUTPUT_BYTES && !outputLimitExceeded) {
        outputLimitExceeded = true;
        child.kill();
      }
    };

    child.stdout?.on("data", (chunk: string | Buffer) =>
      recordOutput(chunk, false),
    );
    child.stderr?.on("data", (chunk: string | Buffer) =>
      recordOutput(chunk, true),
    );
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      rejectRun(err);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (outputLimitExceeded) {
        const err = new Error("git clone の出力が大きすぎます") as Error & {
          stderr?: string;
        };
        err.stderr = stderr;
        rejectRun(err);
        return;
      }
      if (code === 0) {
        resolveRun();
        return;
      }
      const err = new Error(
        signal
          ? `git clone がシグナル ${signal} で終了しました`
          : "git clone に失敗しました",
      ) as Error & { stderr?: string };
      err.stderr = stderr;
      rejectRun(err);
    });
  });
}

function validateCloneDepth(depth: number | undefined): void {
  if (depth !== undefined && (!Number.isSafeInteger(depth) || depth <= 0)) {
    throw new Error("depth は正の整数で指定してください");
  }
}

const cloneRepositoryParameters = Type.Object({
  owner: Type.String({
    description: "リポジトリオーナー（ユーザー名/Organization名）",
  }),
  repo: Type.String({ description: "リポジトリ名" }),
  directory: Type.Optional(
    Type.String({
      description:
        "clone 先ディレクトリ（省略時は /tmp/{repo}。/tmp を基準にする相対パスのみ指定可能）",
    }),
  ),
  depth: Type.Optional(
    Type.Integer({
      description: "shallow clone の履歴深さ（正の整数。省略時は全履歴）",
      minimum: 1,
    }),
  ),
});

export const cloneRepositoryTool: AgentTool<typeof cloneRepositoryParameters> =
  {
    name: "clone-repository",
    label: "Clone GitHub Repository",
    description:
      "GitHub リポジトリをエージェントコンテナ内へ clone する（directory 省略時は一時的な /tmp/{repo}、指定時も /tmp 基準の相対パスに限定。depth 省略時は全履歴、指定時のみ shallow clone。クレデンシャルプロキシ経由でトークンを安全に注入し、エージェントにトークン自体は渡さない）",
    parameters: cloneRepositoryParameters,
    execute: async (_toolCallId, { owner, repo, directory, depth }) => {
      assertValidRepoPart(owner, "owner");
      assertValidRepoPart(repo, "repo");
      validateCloneDepth(depth);

      const dest = resolveCloneDir(repo, directory);
      const baseUrl = resolveProxyBaseUrl("github-git");
      const cloneUrl = `${baseUrl}/${owner}/${repo}.git`;
      const destination = await openSecureCloneDestination(dest);

      const cloneArgs = ["clone"];
      if (depth !== undefined) cloneArgs.push("--depth", String(depth));
      cloneArgs.push(cloneUrl, `/proc/self/fd/${CLONE_DESTINATION_FD}`);

      try {
        await runGitClone(cloneArgs, destination);
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        throw new Error(e.stderr || e.message || "git clone に失敗しました");
      } finally {
        await destination.close().catch(() => {});
      }

      const history = depth === undefined ? "全履歴" : `depth=${depth}`;
      return {
        content: [
          {
            type: "text",
            text: `clone 完了: ${owner}/${repo} → ${dest}（${history}）`,
          },
        ],
        details: { owner, repo, directory: dest, depth: depth ?? null },
      };
    },
  };
