import { execFile } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { promisify } from "node:util";

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
    throw new Error(`絶対パスは指定できません: ${raw}`);
  }
  const normalized = normalize(raw);
  assertNoParentTraversal(
    normalized,
    raw,
    "アクセス拒否: 相対パスの .. でワークスペース外に出ることは許可されていません",
  );
  return join(CLONE_ROOT, normalized);
}

function validateCloneDepth(depth: number | undefined): void {
  if (depth !== undefined && (!Number.isSafeInteger(depth) || depth <= 0)) {
    throw new Error("depth は正の整数で指定してください");
  }
}

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; message?: unknown };
  return e.code === "ENOENT" || e.message === "ENOENT";
}

const cloneRepositoryParameters = Type.Object({
  owner: Type.String({
    description: "リポジトリオーナー（ユーザー名/Organization名）",
  }),
  repo: Type.String({ description: "リポジトリ名" }),
  directory: Type.Optional(
    Type.String({
      description:
        "clone 先ディレクトリ（/tmp からの相対パス。省略時はリポジトリ名。コンテナ終了時に破棄）",
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
      "GitHub リポジトリをエージェントコンテナ内の一時的な /tmp 配下へ clone する（depth 省略時は全履歴、指定時のみ shallow clone。クレデンシャルプロキシ経由でトークンを安全に注入し、エージェントにトークン自体は渡さない）",
    parameters: cloneRepositoryParameters,
    execute: async (_toolCallId, { owner, repo, directory, depth }) => {
      assertValidRepoPart(owner, "owner");
      assertValidRepoPart(repo, "repo");
      validateCloneDepth(depth);

      const dest = resolveCloneDir(repo, directory);
      const baseUrl = resolveProxyBaseUrl("github-git");
      const cloneUrl = `${baseUrl}/${owner}/${repo}.git`;
      const destExistedBefore = await stat(dest).then(
        () => true,
        (error) => !isNotFoundError(error),
      );

      const cloneArgs = ["clone"];
      if (depth !== undefined) cloneArgs.push("--depth", String(depth));
      cloneArgs.push(cloneUrl, dest);

      try {
        await promisify(execFile)("git", cloneArgs, {
          cwd: WORKSPACE,
          timeout: CLONE_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
        });
      } catch (err) {
        // git が作成した dest をクリーンアップしないと、次回実行が
        // "already exists and is not an empty directory" で失敗し続ける。
        // dest が呼び出し前から存在していた場合は触らない。
        if (!destExistedBefore) {
          await rm(dest, { recursive: true, force: true }).catch(() => {});
        }
        const e = err as { stderr?: string; message?: string };
        throw new Error(e.stderr || e.message || "git clone に失敗しました");
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
