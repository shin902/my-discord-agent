import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
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

async function githubFetch(
  owner: string,
  repo: string,
  suffix: string,
): Promise<unknown> {
  assertValidRepoPart(owner, "owner");
  assertValidRepoPart(repo, "repo");
  const baseUrl = resolveProxyBaseUrl("github");
  const path = `/repos/${owner}/${repo}${suffix}`;
  const res = await fetch(`${baseUrl}${path}`, { headers: GITHUB_HEADERS });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API エラー ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function githubPost(
  owner: string,
  repo: string,
  suffix: string,
  body: unknown,
): Promise<unknown> {
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
  return res.json();
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
  pull_request?: unknown;
};

function formatLabels(labels: GitHubIssue["labels"]): string {
  if (!labels || labels.length === 0) return "(なし)";
  return labels.map((l) => l.name ?? "?").join(", ");
}

async function fetchIssueOnly(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<GitHubIssue> {
  const issue = (await githubFetch(
    owner,
    repo,
    `/issues/${issueNumber}`,
  )) as GitHubIssue;
  if (issue.pull_request != null) {
    throw new Error(
      "指定された番号は Pull Request です。Issue 番号を指定してください",
    );
  }
  return issue;
}

const listIssuesParameters = Type.Object({
  owner: Type.String({
    description: "Repository owner (user or organization name).",
  }),
  repo: Type.String({ description: "Repository name." }),
  state: Type.Optional(
    Type.Union(
      [Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")],
      { description: "Issue state to include. Defaults to open." },
    ),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: "Number of issues to return. Defaults to 10; maximum 50.",
      minimum: 1,
      maximum: 50,
    }),
  ),
});

async function fetchIssuesUntilLimit(
  owner: string,
  repo: string,
  state: string,
  limit: number,
): Promise<GitHubIssue[]> {
  const perPage = Math.min(limit, 50);
  const issues: GitHubIssue[] = [];

  for (let page = 1; ; page++) {
    const pageItems = (await githubFetch(
      owner,
      repo,
      `/issues?state=${state}&per_page=${perPage}&page=${page}`,
    )) as GitHubIssue[];
    issues.push(...pageItems.filter((issue) => !issue.pull_request));

    if (issues.length >= perPage || pageItems.length < perPage) {
      return issues.slice(0, perPage);
    }
  }
}

export const listIssuesTool: AgentTool<typeof listIssuesParameters> = {
  name: "list-issues",
  label: "List GitHub Issues",
  description:
    "List issues in a repository, returning their number, title, state, labels, and comment count. Pull requests are excluded.",
  parameters: listIssuesParameters,
  execute: async (_toolCallId, { owner, repo, state = "open", limit = 10 }) => {
    const filtered = await fetchIssuesUntilLimit(
      owner,
      repo,
      state,
      Math.min(limit, 50),
    );

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
    description: "Repository owner (user or organization name).",
  }),
  repo: Type.String({ description: "Repository name." }),
  issue_number: Type.Integer({ description: "Issue number.", minimum: 1 }),
});

export const readIssueTool: AgentTool<typeof readIssueParameters> = {
  name: "read-issue",
  label: "Read GitHub Issue",
  description: "Read the full body of a specified GitHub issue.",
  parameters: readIssueParameters,
  execute: async (_toolCallId, { owner, repo, issue_number }) => {
    const issue = await fetchIssueOnly(owner, repo, issue_number);

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

type GitHubPullRequest = {
  number: number;
  title: string;
  state: string;
  user?: { login?: string };
  base?: { ref?: string };
  head?: { ref?: string };
  created_at?: string;
  updated_at?: string;
  body?: string | null;
};

const readPullRequestParameters = Type.Object({
  owner: Type.String({
    description: "Repository owner (user or organization name).",
  }),
  repo: Type.String({ description: "Repository name." }),
  pull_number: Type.Integer({
    description: "Pull request number.",
    minimum: 1,
  }),
});

function formatPullRequestField(value: string | undefined): string {
  return value?.trim() ? value : "不明";
}

export const readPullRequestTool: AgentTool<typeof readPullRequestParameters> =
  {
    name: "read-pull-request",
    label: "Read GitHub Pull Request",
    description:
      "Read the body and metadata of a specified GitHub pull request and return them as Markdown.",
    parameters: readPullRequestParameters,
    execute: async (_toolCallId, { owner, repo, pull_number }) => {
      const pullRequest = (await githubFetch(
        owner,
        repo,
        `/pulls/${pull_number}`,
      )) as GitHubPullRequest;

      let body = pullRequest.body ?? "";
      if (body.length > MAX_BODY_CHARS) {
        body = `${body.slice(0, MAX_BODY_CHARS)}\n\n...(${body.length - MAX_BODY_CHARS} 文字省略)`;
      }

      const lines = [
        `# #${pullRequest.number} ${pullRequest.title}`,
        "",
        `**状態**: ${formatPullRequestField(pullRequest.state)}`,
        `**作成者**: ${formatPullRequestField(pullRequest.user?.login)}`,
        `**ベースブランチ**: ${formatPullRequestField(pullRequest.base?.ref)}`,
        `**ヘッドブランチ**: ${formatPullRequestField(pullRequest.head?.ref)}`,
        `**作成日時**: ${formatPullRequestField(pullRequest.created_at)}`,
        `**更新日時**: ${formatPullRequestField(pullRequest.updated_at)}`,
        "",
        "---",
        "",
        body || "(本文なし)",
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { owner, repo, pull_number },
      };
    },
  };

type GitHubIssueComment = {
  id?: number;
  user?: { login?: string } | null;
  created_at?: string | null;
  updated_at?: string | null;
  body?: string | null;
};

const GITHUB_PAGE_SIZE = 100;

async function fetchAllGitHubPages<T>(
  owner: string,
  repo: string,
  suffix: string,
): Promise<T[]> {
  const items: T[] = [];

  for (let page = 1; ; page++) {
    const pageItems = (await githubFetch(
      owner,
      repo,
      `${suffix}?per_page=${GITHUB_PAGE_SIZE}&page=${page}`,
    )) as T[];
    items.push(...pageItems);
    if (pageItems.length < GITHUB_PAGE_SIZE) return items;
  }
}

const listIssueCommentsParameters = Type.Object({
  owner: Type.String({
    description: "Repository owner (user or organization name).",
  }),
  repo: Type.String({ description: "Repository name." }),
  issue_number: Type.Integer({ description: "Issue number.", minimum: 1 }),
});

export const listIssueCommentsTool: AgentTool<
  typeof listIssueCommentsParameters
> = {
  name: "list-issue-comments",
  label: "List GitHub Issue Comments",
  description:
    "List all comments on a GitHub issue and return the author, created time, updated time, and body as Markdown.",
  parameters: listIssueCommentsParameters,
  execute: async (_toolCallId, { owner, repo, issue_number }) => {
    const comments = await fetchAllGitHubPages<GitHubIssueComment>(
      owner,
      repo,
      `/issues/${issue_number}/comments`,
    );

    const lines = [`# Issue #${issue_number} のコメント`, ""];
    comments.forEach((comment, index) => {
      lines.push(`## コメント ${index + 1}`);
      lines.push(`- 作者: ${comment.user?.login ?? "不明"}`);
      lines.push(`- 投稿日時: ${comment.created_at ?? "不明"}`);
      lines.push(`- 更新日時: ${comment.updated_at ?? "不明"}`);
      lines.push("", comment.body ?? "(本文なし)", "", "---", "");
    });
    if (comments.length === 0) lines.push("(コメントはありません)");

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { owner, repo, issue_number, count: comments.length },
    };
  },
};

type GitHubPullRequestReview = {
  id?: number;
  user?: { login?: string } | null;
  state?: string | null;
  created_at?: string | null;
  submitted_at?: string | null;
  updated_at?: string | null;
  body?: string | null;
};

type GitHubPullRequestReviewComment = GitHubIssueComment & {
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  side?: string | null;
};

const listPullRequestCommentsParameters = Type.Object({
  owner: Type.String({
    description: "Repository owner (user or organization name).",
  }),
  repo: Type.String({ description: "Repository name." }),
  pull_number: Type.Integer({
    description: "Pull request number.",
    minimum: 1,
  }),
});

function formatGitHubField(value: string | number | null | undefined): string {
  if (value == null || (typeof value === "string" && !value.trim())) {
    return "不明";
  }
  return String(value);
}

function appendMarkdownBody(lines: string[], body: string | null | undefined) {
  lines.push("", body || "(本文なし)", "", "---", "");
}

function formatInlineReviewLocation(
  comment: GitHubPullRequestReviewComment,
): string {
  const fields: string[] = [];
  if (comment.path) fields.push(`path=${comment.path}`);
  if (comment.line != null) fields.push(`line=${comment.line}`);
  if (comment.original_line != null) {
    fields.push(`original_line=${comment.original_line}`);
  }
  if (comment.side) fields.push(`side=${comment.side}`);
  return fields.join(", ");
}

export const listPullRequestCommentsTool: AgentTool<
  typeof listPullRequestCommentsParameters
> = {
  name: "list-pull-request-comments",
  label: "List GitHub Pull Request Comments",
  description:
    "List all conversation comments, reviews, and inline review comments on a pull request and return them as Markdown.",
  parameters: listPullRequestCommentsParameters,
  execute: async (_toolCallId, { owner, repo, pull_number }) => {
    const conversationComments = await fetchAllGitHubPages<GitHubIssueComment>(
      owner,
      repo,
      `/issues/${pull_number}/comments`,
    );
    const reviews = await fetchAllGitHubPages<GitHubPullRequestReview>(
      owner,
      repo,
      `/pulls/${pull_number}/reviews`,
    );
    const inlineComments =
      await fetchAllGitHubPages<GitHubPullRequestReviewComment>(
        owner,
        repo,
        `/pulls/${pull_number}/comments`,
      );

    const lines = [`# Pull Request #${pull_number} のコメント・レビュー`, ""];

    lines.push("## 会話コメント（Issue コメント）", "");
    if (conversationComments.length === 0) {
      lines.push("(会話コメントはありません)", "");
    } else {
      conversationComments.forEach((comment, index) => {
        lines.push(`### コメント ${index + 1}`);
        lines.push(`- 作者: ${formatGitHubField(comment.user?.login)}`);
        lines.push(`- 投稿日時: ${formatGitHubField(comment.created_at)}`);
        lines.push(`- 更新日時: ${formatGitHubField(comment.updated_at)}`);
        appendMarkdownBody(lines, comment.body);
      });
    }

    lines.push("## レビュー投稿", "");
    if (reviews.length === 0) {
      lines.push("(レビューはありません)", "");
    } else {
      reviews.forEach((review, index) => {
        lines.push(`### レビュー ${index + 1}`);
        lines.push(`- 作者: ${formatGitHubField(review.user?.login)}`);
        lines.push(`- 状態: ${formatGitHubField(review.state)}`);
        lines.push(`- 作成日時: ${formatGitHubField(review.created_at)}`);
        lines.push(`- 提出日時: ${formatGitHubField(review.submitted_at)}`);
        lines.push(`- 更新日時: ${formatGitHubField(review.updated_at)}`);
        appendMarkdownBody(lines, review.body);
      });
    }

    lines.push("## インラインレビューコメント", "");
    if (inlineComments.length === 0) {
      lines.push("(インラインレビューコメントはありません)", "");
    } else {
      inlineComments.forEach((comment, index) => {
        lines.push(`### インラインコメント ${index + 1}`);
        lines.push(`- 作者: ${formatGitHubField(comment.user?.login)}`);
        lines.push(`- 投稿日時: ${formatGitHubField(comment.created_at)}`);
        lines.push(`- 更新日時: ${formatGitHubField(comment.updated_at)}`);
        const location = formatInlineReviewLocation(comment);
        if (location) lines.push(`- 位置: ${location}`);
        appendMarkdownBody(lines, comment.body);
      });
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: {
        owner,
        repo,
        pull_number,
        count:
          conversationComments.length + reviews.length + inlineComments.length,
      },
    };
  },
};

type GitHubComment = {
  id: number;
  html_url: string;
};

const commentIssueParameters = Type.Object({
  owner: Type.String({
    description: "Repository owner (user or organization name).",
  }),
  repo: Type.String({ description: "Repository name." }),
  issue_number: Type.Integer({ description: "Issue number.", minimum: 1 }),
  body: Type.String({
    description: `Comment body in Markdown, up to ${MAX_COMMENT_CHARS.toLocaleString("en-US")} characters.`,
    minLength: 1,
    maxLength: MAX_COMMENT_CHARS,
  }),
});

export const commentIssueTool: AgentTool<typeof commentIssueParameters> = {
  name: "comment-issue",
  label: "Comment on GitHub Issue",
  description:
    "Post a comment to a specified GitHub issue. This is a public write operation, so post only to the issue explicitly requested by the user.",
  parameters: commentIssueParameters,
  execute: async (_toolCallId, { owner, repo, issue_number, body }) => {
    if (body.length === 0) {
      throw new Error("コメント本文は空にできません");
    }
    if (body.length > MAX_COMMENT_CHARS) {
      throw new Error(
        `コメント本文が長すぎます（${body.length} 文字、最大 ${MAX_COMMENT_CHARS} 文字）`,
      );
    }

    await fetchIssueOnly(owner, repo, issue_number);
    const comment = (await githubPost(
      owner,
      repo,
      `/issues/${issue_number}/comments`,
      { body },
    )) as GitHubComment;

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
