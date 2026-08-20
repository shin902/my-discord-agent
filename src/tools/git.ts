import { execFile } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { promisify } from "node:util";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { z } from "zod";

import { assertValidRepoPart } from "./github.js";
import { assertNoParentTraversal } from "./path-safety.js";
import { resolveProxyBaseUrl } from "./proxy-url.js";

const WORKSPACE = "/workspace";
const CLONE_TIMEOUT_MS = 120_000;

type GitExecOptions = {
  cwd: string;
  timeout: number;
  maxBuffer: number;
};

type GitDependencies = {
  execFile: (command: string, args: string[], options: GitExecOptions) => Promise<void>;
  stat: (path: string) => Promise<void>;
  rm: (path: string, options: { recursive: boolean; force: boolean }) => Promise<void>;
};

const defaultDependencies: GitDependencies = {
  execFile: (command, args, options) => promisify(execFile)(command, args, options).then(() => undefined),
  stat: (path) => stat(path).then(() => undefined),
  rm,
};

function resolveCloneDir(repo: string, directory?: string): string {
  const raw = directory?.trim() || repo;
  if (isAbsolute(raw)) {
    throw new Error(`絶対パスは指定できません: ${raw}`);
  }
  const normalized = normalize(raw);
  assertNoParentTraversal(
    normalized,
    raw,
    "アクセス拒否: 相対パスの .. でワークスペース外に出ることは許可されていません",
  );
  return join(WORKSPACE, normalized);
}

const cloneRepositoryParameters = Type.Object({
  owner: Type.String({
    description: "リポジトリオーナー（ユーザー名/Organization名）",
  }),
  repo: Type.String({ description: "リポジトリ名" }),
  directory: Type.Optional(
    Type.String({
      description:
        "clone 先ディレクトリ（ワークスペースルートからの相対パス。省略時はリポジトリ名）",
    }),
  ),
});

export function createCloneRepositoryTool(
  dependencies: GitDependencies = defaultDependencies,
): AgentTool<typeof cloneRepositoryParameters> {
  return {
    name: "clone-repository",
    label: "Clone GitHub Repository",
    description:
      "GitHub リポジトリをワークスペース内に shallow clone する（クレデンシャルプロキシ経由でトークンを安全に注入し、エージェントにトークン自体は渡さない）",
    parameters: cloneRepositoryParameters,
    execute: async (_toolCallId, { owner, repo, directory }) => {
      assertValidRepoPart(owner, "owner");
      assertValidRepoPart(repo, "repo");

      const dest = resolveCloneDir(repo, directory);
      const baseUrl = resolveProxyBaseUrl("github-git");
      const cloneUrl = `${baseUrl}/${owner}/${repo}.git`;
      const destExistedBefore = await dependencies.stat(dest).then(
        () => true,
        () => false,
      );

      try {
        await dependencies.execFile(
          "git",
          ["clone", "--depth", "1", cloneUrl, dest],
          { cwd: WORKSPACE, timeout: CLONE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        );
      } catch (err) {
        // git が作成した dest をクリーンアップしないと、次回実行が
        // "already exists and is not an empty directory" で失敗し続ける。
        // dest が呼び出し前から存在していた場合は触らない。
        if (!destExistedBefore) {
          await dependencies.rm(dest, { recursive: true, force: true }).catch(() => {});
        }
        const details = z
          .object({
            stderr: z.string().optional(),
            message: z.string().optional(),
          })
          .safeParse(err).data;
        throw new Error(
          details?.stderr || details?.message || "git clone に失敗しました",
        );
      }

      return {
        content: [
          { type: "text", text: `clone 完了: ${owner}/${repo} → ${dest}` },
        ],
        details: { owner, repo, directory: dest },
      };
    },
  };
}

export const cloneRepositoryTool = createCloneRepositoryTool();
