import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getProxyPort } from "../../proxy/credential-proxy-server.js";
import {
  assertValidRepoPart,
  GITHUB_HEADERS,
  type GitHubIssue,
  GitHubIssueSchema,
} from "../../tools/github.js";
import { NonRetryableError } from "../../utils/error.js";
import { createFileLock } from "../../utils/lock.js";
import type { CronContext } from "../runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const STATE_PATH = path.join(ROOT, "data/issue-triage/state.json");

type IssueTriageResponse = {
  ok: boolean;
  status?: number;
  json?(): Promise<GitHubIssue[]>;
  text?(): Promise<string>;
};
type IssueTriageDependencies = {
  exists: (path: string) => boolean;
  mkdir: (path: string, options: { recursive: boolean }) => Promise<void>;
  readFile: (path: string, encoding: "utf-8") => Promise<string>;
  writeFile: (path: string, data: string, encoding: "utf-8") => Promise<void>;
  getProxyPort: () => number;
  fetch: (input: string, init?: RequestInit) => Promise<IssueTriageResponse>;
};

const SettingsSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  // 省略時は owner 本人のみを処理対象にする（オーナー限定フィルタのデフォルト）
  allowedAuthors: z.array(z.string()).optional(),
});

// issue番号 → 最後に処理した時点の updated_at / コメント数。
// updated_at が変化していなければ再処理しない。
// updated_at が変化していても、コメント数の増分が前回投入分の+1だけなら
// bot自身のコメントによる更新とみなし再処理しない（gh は本人アカウントと
// 同一なため、コメント投稿者で bot/owner を区別できない代替策）
type TriageState = Record<string, { updatedAt: string; commentCount: number }>;

const triageStateSchema = z.record(
  z.string(),
  z.object({ updatedAt: z.string(), commentCount: z.number() }),
);

function stateKey(owner: string, repo: string, issueNumber: number): string {
  return `${owner}/${repo}#${issueNumber}`;
}

// runner.ts の loadState/saveState と同様にメモリキャッシュする。
// state.json は1ファイル共有のため、複数ジョブが同一tickで並行実行されても
// withStateLock の直列化さえ守れば、ディスクの再読込なしに同じオブジェクトを
// 安全に読み書きできる（このプロセス内の更新は常にロック経由で同期的に反映される）。
let cachedState: TriageState | null = null;

export function createIssueTriageHandler(
  dependencies: IssueTriageDependencies = {
    exists: () => existsSync(STATE_PATH),
    mkdir: async () => { await mkdir(path.dirname(STATE_PATH), { recursive: true }); },
    readFile: async () => readFile(STATE_PATH, "utf-8"),
    writeFile: async (_path, data) => { await writeFile(STATE_PATH, data, "utf-8"); },
    getProxyPort,
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      return {
        ok: response.ok,
        status: response.status,
        json: async () => z.array(GitHubIssueSchema).parse(await response.json()),
        text: () => response.text(),
      };
    },
  },
) {
  cachedState = null;
  const loadState = async (): Promise<TriageState> => {
  if (cachedState !== null) return cachedState;
  if (!dependencies.exists(STATE_PATH)) {
    cachedState = {};
    return cachedState;
  }
  cachedState = triageStateSchema.parse(
    JSON.parse(await dependencies.readFile(STATE_PATH, "utf-8")),
  );
  return cachedState;
  };
  const saveState = async (state: TriageState): Promise<void> => {
    cachedState = state;
    await dependencies.mkdir(path.dirname(STATE_PATH), { recursive: true });
    await dependencies.writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
  };

// state.json は owner/repo を問わず1ファイル共有のため、複数の issue-triage
// ジョブが同一tickで並行実行されると read→write 間に割り込みが発生し、
// 後勝ちの書き込みが他ジョブの更新を丸ごと消してしまう（inbox.ts と同じ問題）。
// 同一プロセス内の操作をPromiseチェーンで直列化することで読み書きをアトミックにする。
  const withStateLock = createFileLock();

// appendInbox 成功直後に呼び、ロック内で最新状態に1キーだけ更新・書き戻す。
  const recordProcessed = async (
    key: string,
    updatedAt: string,
    commentCount: number,
  ): Promise<void> => {
  await withStateLock(async () => {
    const latest = await loadState();
    latest[key] = { updatedAt, commentCount };
    await saveState(latest);
  });
  };

const PER_PAGE = 100;
const MAX_PAGES = 10;

  const fetchIssuesByCreator = async (
    owner: string,
    repo: string,
    creator: string,
  ): Promise<GitHubIssue[]> => {
  const port = dependencies.getProxyPort();
  const issues: GitHubIssue[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await dependencies.fetch(
      `http://localhost:${port}/github/repos/${owner}/${repo}/issues?state=open&per_page=${PER_PAGE}&page=${page}&creator=${encodeURIComponent(creator)}`,
      { headers: GITHUB_HEADERS },
    );
    if (!res.ok) {
      const text = await res.text?.().catch(() => "") ?? "";
      throw new Error(`GitHub API エラー ${res.status ?? 0}: ${text.slice(0, 200)}`);
    }
    const pageIssues = z.array(GitHubIssueSchema).parse(await res.json?.());
    issues.push(...pageIssues);
    if (pageIssues.length < PER_PAGE) break;
    if (page === MAX_PAGES) {
      console.warn(
        `[issue-triage] ${owner}/${repo} creator=${creator} の Open Issue が上限(${MAX_PAGES * PER_PAGE}件)に達しました。一部のIssueが取得対象から漏れている可能性があります`,
      );
    }
  }

  return issues;
  };

// allowedAuthors（既定: owner本人）単位で creator フィルタ付きAPI呼び出しを行う。
// 全Open Issueを取得してからクライアント側で絞り込むより、対象外の投稿者分の
// 取得・ページングコストを避けられる。
  const fetchOpenIssues = async (
    owner: string,
    repo: string,
    authors: string[],
  ): Promise<GitHubIssue[]> => {
  const issues: GitHubIssue[] = [];
  const seen = new Set<number>();
  for (const author of authors) {
    for (const issue of await fetchIssuesByCreator(owner, repo, author)) {
      if (seen.has(issue.number)) continue;
      seen.add(issue.number);
      issues.push(issue);
    }
  }
  return issues.filter((issue) => !issue.pull_request);
  };

function buildPrompt(owner: string, repo: string, issue: GitHubIssue): string {
  return [
    `リポジトリ ${owner}/${repo} の Issue #${issue.number}「${issue.title}」を棚卸ししてください。`,
    "",
    `0. 最初に対象リポジトリで \`git pull\` を実行し、最新のコードを取得する`,
    `1. read-issue（owner=${owner}, repo=${repo}, issue_number=${issue.number}）で本文を取得する`,
    "2. /repo 配下を bash（grep/find/cat 等）で調査し、判断の根拠となるコード上の箇所を確認する",
    "3. 分類（実装済みっぽい／古い・情報不足／重複候補／着手しやすそう、のいずれか。根拠が無ければ判断不能として何もしない）を行う",
    "4. 根拠が示せた場合のみ comment-issue で判断結果と根拠を日本語でコメントする",
  ].join("\n");
}

  return async function handler(ctx: CronContext): Promise<void> {
  if (!ctx.channelId) {
    throw new NonRetryableError(
      "[issue-triage] channelId が設定されていません",
    );
  }
  if (!ctx.groupName) {
    throw new NonRetryableError(
      "[issue-triage] groupName が設定されていません",
    );
  }

  const parsed = SettingsSchema.safeParse(ctx.settings);
  if (!parsed.success) {
    throw new NonRetryableError(
      `[issue-triage] settings が不正です: ${parsed.error.message}`,
    );
  }
  const { owner, repo, allowedAuthors } = parsed.data;
  try {
    assertValidRepoPart(owner, "owner");
    assertValidRepoPart(repo, "repo");
  } catch (err) {
    throw new NonRetryableError(
      `[issue-triage] owner/repo が不正です: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const authors = allowedAuthors ?? [owner];
  // GitHubのユーザー名は大文字小文字を区別しないため、比較前に正規化する
  const allowed = new Set(authors.map((author) => author.toLowerCase()));

  // GitHub API/proxyの一時的な障害（ネットワーク・レート制限等）はここでは握り潰さず、
  // そのまま呼び出し元の runner に投げて次tickでのリトライ判断に委ねる
  const issues = await fetchOpenIssues(owner, repo, authors);

  // creator フィルタはAPI側で行われるが、投稿者がリポジトリオーナー
  // （または allowedAuthors）でないIssueが紛れ込まないよう念のため二重チェックする
  const ownerIssues = issues.filter((issue) =>
    allowed.has((issue.user?.login ?? "").toLowerCase()),
  );
  if (ownerIssues.length === 0) return;

  const state = await loadState();

  // updated_at が前回処理時と変わっていないIssueは再処理・再コメントしない
  // (GitHub API は issue 一覧で常に updated_at を返すため、空文字フォールバックは型上の保険)
  const absorbed: Array<{
    key: string;
    updatedAt: string;
    commentCount: number;
  }> = [];
  const targets = ownerIssues.filter((issue) => {
    const key = stateKey(owner, repo, issue.number);
    const prev = state[key];
    if (!prev) return true;
    if (prev.updatedAt === (issue.updated_at ?? "")) return false;

    // updated_at は変化しているが、コメント数の増分がちょうど+1なら
    // 前回投入した棚卸しコメント自身による更新とみなしてスキップする。
    // state だけ最新値に更新し、以後同じ理由で誤検知し続けないようにする。
    const currentComments = issue.comments ?? 0;
    if (currentComments === prev.commentCount + 1) {
      absorbed.push({
        key,
        updatedAt: issue.updated_at ?? "",
        commentCount: currentComments,
      });
      return false;
    }
    return true;
  });

  // 自己コメント吸収分はロック内でまとめて永続化する
  if (absorbed.length > 0) {
    await withStateLock(async () => {
      const latest = await loadState();
      for (const { key, updatedAt, commentCount } of absorbed) {
        latest[key] = { updatedAt, commentCount };
      }
      await saveState(latest);
    });
  }
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
      await recordProcessed(
        stateKey(owner, repo, issue.number),
        issue.updated_at ?? "",
        issue.comments ?? 0,
      );
    } catch (err) {
      console.error(`[issue-triage] Issue #${issue.number} の投入に失敗:`, err);
    }
  }
  };
}

export default createIssueTriageHandler();
