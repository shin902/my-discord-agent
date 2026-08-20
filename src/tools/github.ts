import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { z } from "zod";
import { resolveProxyBaseUrl } from "./proxy-url.js";

const MAX_BODY_CHARS = 8000;
const MAX_COMMENT_CHARS = 8000;

export const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "my-discord-agent",
};

const REPO_NAME_RE = /^[a-zA-Z0-9._-]+$/;

export function assertValidRepoPart(value: string, label: string): void {
  if (!REPO_NAME_RE.test(value) || value.includes("..") || value === ".") {
    throw new Error(`無効な${label}: ${value}`);
  }
}

type JsonValue = z.infer<typeof JsonValueSchema>;
const JsonValueSchema = z.json();

async function githubFetch(
  owner: string,
  repo: string,
  suffix: string,
): Promise<JsonValue> {
  assertValidRepoPart(owner, "owner");
  assertValidRepoPart(repo, "repo");
  const baseUrl = resolveProxyBaseUrl("github");
  const path = `/repos/${owner}/${repo}${suffix}`;
  const res = await fetch(`${baseUrl}${path}`, { headers: GITHUB_HEADERS });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API エラー ${res.status}: ${text.slice(0, 200)}`);
  }
  return JsonValueSchema.parse(await res.json());
}

async function githubPost(
  owner: string,
  repo: string,
  suffix: string,
  body: JsonValue,
): Promise<JsonValue> {
  assertValidRepoPart(owner, "owner");
  assertValidRepoPart(repo, "repo");
  const baseUrl = resolveProxyBaseUrl("github");
  const path = `/repos/${owner}/${repo}${suffix}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { ...GITHUB_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API エラー ${res.status}: ${text.slice(0, 200)}`);
  }
  return JsonValueSchema.parse(await res.json());
}

export type GitHubIssue = {
  number: number;
  title: string;
  state: string;
  user?: { login?: string };
  labels?: Array<{ name?: string }>;
  comments?: number;
  created_at?: string;
  updated_at?: string;
  body?: string;
  pull_request?: JsonValue;
};

export const GitHubIssueSchema: z.ZodType<GitHubIssue> = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string().default("open"),
  user: z.object({ login: z.string().optional() }).optional(),
  labels: z.array(z.object({ name: z.string().optional() })).optional(),
  comments: z.number().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  body: z.string().optional(),
  pull_request: JsonValueSchema.optional(),
});
const GitHubCommentSchema = z.object({ id: z.number(), html_url: z.string() });

function formatLabels(labels: GitHubIssue["labels"]): string {
  if (!labels || labels.length === 0) return "(なし)";
  return labels.map((l) => l.name ?? "?").join(", ");
}

const listIssuesParameters = Type.Object({
  owner: Type.String({
    description: "リポジトリオーナー（ユーザー名/Organization名）",
  }),
  repo: Type.String({ description: "リポジトリ名" }),
  state: Type.Optional(
    Type.Union(
      [Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")],
      { description: "Issue の状態（デフォルト: open）" },
    ),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: "取得件数（デフォルト: 10、最大: 50）",
      minimum: 1,
      maximum: 50,
    }),
  ),
});

export const listIssuesTool: AgentTool<typeof listIssuesParameters> = {
  name: "list-issues",
  label: "List GitHub Issues",
  description:
    "指定リポジトリの Issue 一覧を取得する。番号・タイトル・状態・ラベル・コメント数を返す（Pull Request は除外）",
  parameters: listIssuesParameters,
  execute: async (_toolCallId, { owner, repo, state = "open", limit = 10 }) => {
    const perPage = Math.min(limit, 50);
    const issues = z.array(GitHubIssueSchema).parse(
      await githubFetch(
        owner,
        repo,
        `/issues?state=${state}&per_page=${perPage}`,
      ),
    );

    const filtered = issues.filter((issue) => !issue.pull_request);

    const lines: string[] = [
      `## Issue 一覧（${owner}/${repo}, state=${state}）`,
      "",
    ];
    for (const issue of filtered) {
      lines.push(`### #${issue.number} ${issue.title}`);
      lines.push(`- 状態: ${issue.state}`);
      lines.push(`- 作成者: ${issue.user?.login ?? "不明"}`);
      lines.push(`- ラベル: ${formatLabels(issue.labels)}`);
      lines.push(`- コメント数: ${issue.comments ?? 0}`);
      lines.push(`- 更新日時: ${issue.updated_at}`);
      lines.push("");
    }
    if (filtered.length === 0) lines.push("(Issue はありません)");

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { owner, repo, state, count: filtered.length },
    };
  },
};

const readIssueParameters = Type.Object({
  owner: Type.String({
    description: "リポジトリオーナー（ユーザー名/Organization名）",
  }),
  repo: Type.String({ description: "リポジトリ名" }),
  issue_number: Type.Integer({ description: "Issue 番号" }),
});

export const readIssueTool: AgentTool<typeof readIssueParameters> = {
  name: "read-issue",
  label: "Read GitHub Issue",
  description: "指定した Issue の本文全文を取得する",
  parameters: readIssueParameters,
  execute: async (_toolCallId, { owner, repo, issue_number }) => {
    const issue = GitHubIssueSchema.parse(
      await githubFetch(owner, repo, `/issues/${issue_number}`),
    );

    let body = issue.body ?? "";
    if (body.length > MAX_BODY_CHARS) {
      body = `${body.slice(0, MAX_BODY_CHARS)}\n\n...(${body.length - MAX_BODY_CHARS} 文字省略)`;
    }

    const lines = [
      `# #${issue.number} ${issue.title}`,
      "",
      `**状態**: ${issue.state}`,
      `**作成者**: ${issue.user?.login ?? "不明"}`,
      `**ラベル**: ${formatLabels(issue.labels)}`,
      `**作成日時**: ${issue.created_at}`,
      `**更新日時**: ${issue.updated_at}`,
      "",
      "---",
      "",
      body,
    ];

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { owner, repo, issue_number },
    };
  },
};

const commentIssueParameters = Type.Object({
  owner: Type.String({
    description: "リポジトリオーナー（ユーザー名/Organization名）",
  }),
  repo: Type.String({ description: "リポジトリ名" }),
  issue_number: Type.Integer({ description: "Issue 番号" }),
  body: Type.String({
    description: `コメント本文（Markdown可、最大 ${MAX_COMMENT_CHARS} 文字）`,
  }),
});

export const commentIssueTool: AgentTool<typeof commentIssueParameters> = {
  name: "comment-issue",
  label: "Comment on GitHub Issue",
  description:
    "指定した Issue にコメントを投稿する。GitHub 上に公開される書き込み操作のため、明示的に指示された Issue 以外には投稿しないこと",
  parameters: commentIssueParameters,
  execute: async (_toolCallId, { owner, repo, issue_number, body }) => {
    if (body.length > MAX_COMMENT_CHARS) {
      throw new Error(
        `コメント本文が長すぎます（${body.length} 文字、最大 ${MAX_COMMENT_CHARS} 文字）`,
      );
    }

    const comment = GitHubCommentSchema.parse(
      await githubPost(owner, repo, `/issues/${issue_number}/comments`, {
        body,
      }),
    );
    return {
      content: [
        {
          type: "text",
          text: `Issue #${issue_number} にコメントを投稿しました\n- リンク: ${comment.html_url}`,
        },
      ],
      details: { owner, repo, issue_number, commentId: comment.id },
    };
  },
};
