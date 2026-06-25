import { execFile } from "node:child_process";
import { isAbsolute, join, normalize } from "node:path";
import { promisify } from "node:util";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import { assertValidRepoPart } from "./github.js";
import { assertNoParentTraversal } from "./path-safety.js";
import { resolveProxyBaseUrl } from "./proxy-url.js";

const WORKSPACE = "/workspace";
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

export const cloneRepositoryTool: AgentTool<typeof cloneRepositoryParameters> =
  {
    name: "clone_repository",
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

      try {
        await promisify(execFile)(
          "git",
          ["clone", "--depth", "1", cloneUrl, dest],
          { cwd: WORKSPACE, timeout: CLONE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        );
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        throw new Error(e.stderr || e.message || "git clone に失敗しました");
      }

      return {
        content: [
          { type: "text", text: `clone 完了: ${owner}/${repo} → ${dest}` },
        ],
        details: { owner, repo, directory: dest },
      };
    },
  };
