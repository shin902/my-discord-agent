import { execFile } from "node:child_process";
import { isAbsolute, normalize, resolve } from "node:path";
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
    throw new Error(`clone 先は /tmp 配下の相対パスで指定してください (${raw})`);
  }

  const normalized = normalize(raw);
  assertNoParentTraversal(
    normalized,
    raw,
    "アクセス拒否: clone 先が /tmp 外に出ることは許可されていません",
  );
  return resolve(CLONE_ROOT, normalized);
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
