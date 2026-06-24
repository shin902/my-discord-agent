import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getProxyPort } from "../../proxy/credential-proxy-server.js";
import { assertValidRepoPart } from "../../tools/github.js";
import type { CronContext } from "../runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const STATE_PATH = path.join(ROOT, "data/issue-triage/state.json");

const SettingsSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  // 省略時は owner 本人のみを処理対象にする（オーナー限定フィルタのデフォルト）
  allowedAuthors: z.array(z.string()).optional(),
});

type GitHubIssue = {
  number: number;
  title: string;
  user?: { login?: string };
  updated_at: string;
  pull_request?: unknown;
};

// issue番号 → 最後に処理した時点の updated_at。変化が無ければ再処理しない
type TriageState = Record<string, string>;

function stateKey(owner: string, repo: string, issueNumber: number): string {
  return `${owner}/${repo}#${issueNumber}`;
}

async function loadState(): Promise<TriageState> {
  if (!existsSync(STATE_PATH)) return {};
  return JSON.parse(await readFile(STATE_PATH, "utf-8")) as TriageState;
}

async function saveState(state: TriageState): Promise<void> {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

const PER_PAGE = 100;
const MAX_PAGES = 10;

async function fetchOpenIssues(
  owner: string,
  repo: string,
): Promise<GitHubIssue[]> {
  assertValidRepoPart(owner, "owner");
  assertValidRepoPart(repo, "repo");

  const port = getProxyPort();
  const issues: GitHubIssue[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(
      `http://localhost:${port}/github/repos/${owner}/${repo}/issues?state=open&per_page=${PER_PAGE}&page=${page}`,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub API エラー ${res.status}: ${text.slice(0, 200)}`);
    }
    const pageIssues = (await res.json()) as GitHubIssue[];
    issues.push(...pageIssues);
    if (pageIssues.length < PER_PAGE) break;
  }

  return issues.filter((issue) => !issue.pull_request);
}

function buildPrompt(owner: string, repo: string, issue: GitHubIssue): string {
  return [
    `リポジトリ ${owner}/${repo} の Issue #${issue.number}「${issue.title}」を棚卸ししてください。`,
    "",
    `1. read_issue（owner=${owner}, repo=${repo}, issue_number=${issue.number}）で本文を取得する`,
    "2. /repo 配下を bash（grep/find/cat 等）で調査し、判断の根拠となるコード上の箇所を確認する",
    "3. 分類（実装済みっぽい／古い・情報不足／重複候補／着手しやすそう、のいずれか。根拠が無ければ判断不能として何もしない）を行う",
    "4. 根拠が示せた場合のみ comment_issue で判断結果と根拠を日本語でコメントする",
  ].join("\n");
}

export default async function handler(ctx: CronContext): Promise<void> {
  if (!ctx.channelId) {
    console.error("[issue-triage] channelId が設定されていません");
    return;
  }
  if (!ctx.groupName) {
    console.error("[issue-triage] groupName が設定されていません");
    return;
  }

  const parsed = SettingsSchema.safeParse(ctx.settings);
  if (!parsed.success) {
    console.error("[issue-triage] settings が不正です:", parsed.error.message);
    return;
  }
  const { owner, repo, allowedAuthors } = parsed.data;
  // GitHubのユーザー名は大文字小文字を区別しないため、比較前に正規化する
  const allowed = new Set(
    (allowedAuthors ?? [owner]).map((author) => author.toLowerCase()),
  );

  let issues: GitHubIssue[];
  try {
    issues = await fetchOpenIssues(owner, repo);
  } catch (err) {
    console.error("[issue-triage] Issue 一覧の取得に失敗:", err);
    return;
  }

  // 投稿者がリポジトリオーナー（または allowedAuthors）でないIssueは
  // 第三者がissue本文へ攻撃文を仕込める余地を作らないため処理対象から除外する
  const ownerIssues = issues.filter((issue) =>
    allowed.has((issue.user?.login ?? "").toLowerCase()),
  );
  if (ownerIssues.length === 0) return;

  const state = await loadState();

  // updated_at が前回処理時と変わっていないIssueは再処理・再コメントしない
  const targets = ownerIssues.filter((issue) => {
    const prevUpdatedAt = state[stateKey(owner, repo, issue.number)];
    return prevUpdatedAt !== issue.updated_at;
  });
  if (targets.length === 0) return;

  console.log(`[issue-triage] ${targets.length} 件のIssueを処理します`);

  for (const issue of targets) {
    try {
      await ctx.appendInbox({
        channelId: ctx.channelId,
        groupName: ctx.groupName,
        sessionId: `cron-${ctx.id}-${owner}-${repo}-${issue.number}-${Date.now()}`,
        content: buildPrompt(owner, repo, issue),
        timestamp: new Date().toISOString(),
        cronJobId: ctx.id,
      });
      // appendInbox 成功直後にstateを保存することで、途中でクラッシュしても
      // 既に投入済みのIssueが重複してinboxに投入されることを防ぐ
      state[stateKey(owner, repo, issue.number)] = issue.updated_at;
      await saveState(state);
    } catch (err) {
      console.error(`[issue-triage] Issue #${issue.number} の投入に失敗:`, err);
    }
  }
}
