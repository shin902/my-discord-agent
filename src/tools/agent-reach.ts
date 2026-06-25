import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import { execAsync } from "./exec.js";
import { resolveProxyBaseUrl } from "./proxy-url.js";

// Reddit は bot 判定が厳しく、汎用的な curl の User-Agent では JS チャレンジで
// ブロックされる。ログインに使ったブラウザに近い UA を送ることで通過率を上げる。
const REDDIT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const WORKSPACE = "/workspace";
// 外部コマンド（curl/yt-dlp等）の出力先として使う作業ディレクトリ。
// フェッチ結果はツールコール結果に直接返すため、ここは処理後に削除する一時領域。
const TMP_DIR = ".agent-reach-tmp";
const TIMEOUT_MS = 120_000;

const PRIVATE_IP = [
  /^0\.0\.0\.0$/,
  /^127\./,
  /^169\.254\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^::1$/,
  /^f[cd][0-9a-f]{2}:/i, // fc00::/7 (fc00:: と fd00:: の両方)
  /^fe80:/i,
  /^::ffff:(127\.|10\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/i, // IPv4マップドアドレス
];

export function isPrivateAddress(ip: string): boolean {
  return PRIVATE_IP.some((r) => r.test(ip));
}

function shellQuote(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

type ServiceType =
  | "youtube"
  | "github-repo"
  | "reddit"
  | "rss"
  | "x-twitter"
  | "web";

export function detectService(parsed: URL): ServiceType {
  const host = parsed.hostname.replace(/^www\./, "");
  if (host === "youtube.com" || host === "youtu.be") return "youtube";
  if (host === "github.com" && /^\/[^/]+\/[^/?#]+\/?$/.test(parsed.pathname))
    return "github-repo";
  if (host === "reddit.com") return "reddit";
  if (
    (host === "x.com" || host === "twitter.com") &&
    /\/[^/]+\/status\/\d+/.test(parsed.pathname)
  )
    return "x-twitter";
  const p = parsed.pathname.toLowerCase();
  if (
    p.endsWith(".xml") ||
    p.endsWith(".rss") ||
    p.includes("/feed") ||
    p.includes("/rss")
  )
    return "rss";
  return "web";
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/** VTT 字幕ファイルからタイムスタンプを除いたテキストを抽出する */
export function parseVtt(content: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  const timestamp = String.raw`\d{2}:\d{2}:\d{2}[.,]\d{3}`;
  const cueSetting = String.raw`(?:align:[A-Za-z-]+|position:[^\s%]+%?|line:[^\s%]+%?|size:[^\s%]+%?|vertical:[A-Za-z-]+)`;
  const cueTiming = new RegExp(
    `${timestamp}\\s*-->\\s*${timestamp}(?:\\s+${cueSetting})*`,
    "g",
  );
  const orphanCueEnd = new RegExp(
    `\\s*-->\\s*${timestamp}(?:\\s+${cueSetting})*`,
    "g",
  );

  for (const line of content
    .replace(cueTiming, "\n")
    .replace(orphanCueEnd, "\n")
    .split("\n")) {
    const t = line.trim();
    if (!t) continue;
    if (
      t.startsWith("WEBVTT") ||
      t.startsWith("Kind:") ||
      t.startsWith("Language:")
    )
      continue;
    if (/^\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->/.test(t)) continue;
    if (/^\d+$/.test(t)) continue;
    // インラインタイミングタグ（<00:00:00.000>）を含む行はスキップ（クリーン行で代替される）
    if (/<\d{2}:\d{2}:\d{2}[.,]\d{3}>/.test(t)) continue;
    // <c> 等の残留タグを除去
    const clean = t.replace(/<[^>]+>/g, "").trim();
    if (!clean) continue;
    // 自動字幕は同一テキストが複数 cue にまたがって重複する
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  // 全セグメントを連結し、。区切りで改行する
  return out.join("").replace(/。/g, "。\n").trim();
}

/** yt-dlp の巨大 JSON を Markdown サマリーに変換する */
async function buildYouTubeMarkdown(
  metaJsonPath: string,
  subsDir: string,
): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(metaJsonPath, "utf-8");
  } catch {
    return "(メタデータの読み込みに失敗しました)";
  }

  // yt-dlp は先頭に WARNING 行を出すことがある。JSON 部分だけ抽出する。
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1)
    return `(JSON が見つかりません)\n\n${raw.slice(0, 2000)}`;

  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(raw.slice(jsonStart));
  } catch {
    return `(JSON パース失敗)\n\n${raw.slice(jsonStart, jsonStart + 2000)}`;
  }

  const str = (k: string) =>
    typeof meta[k] === "string" ? (meta[k] as string) : "";
  const num = (k: string) =>
    typeof meta[k] === "number" ? (meta[k] as number) : null;

  const lines: string[] = [];

  lines.push(`# ${str("title") || "(タイトル不明)"}`);
  lines.push("");

  const channel = str("channel") || str("uploader");
  if (channel) lines.push(`**チャンネル**: ${channel}`);

  const uploadDate = str("upload_date");
  if (uploadDate.length === 8) {
    lines.push(
      `**投稿日**: ${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`,
    );
  }

  const duration = num("duration");
  if (duration !== null)
    lines.push(`**再生時間**: ${formatDuration(duration)}`);

  const views = num("view_count");
  if (views !== null) lines.push(`**視聴回数**: ${views.toLocaleString()}`);

  const likes = num("like_count");
  if (likes !== null) lines.push(`**いいね**: ${likes.toLocaleString()}`);

  const tags = meta.tags;
  if (Array.isArray(tags) && tags.length > 0) {
    lines.push(`**タグ**: ${(tags as string[]).join(", ")}`);
  }

  const desc = str("description");
  if (desc) {
    lines.push("", "## 説明", "", desc);
  }

  const chapters = meta.chapters;
  if (Array.isArray(chapters) && chapters.length > 0) {
    lines.push("", "## チャプター", "");
    for (const ch of chapters as Array<Record<string, unknown>>) {
      const t =
        typeof ch.start_time === "number"
          ? formatDuration(ch.start_time as number)
          : "?";
      lines.push(`- ${t} ${ch.title ?? ""}`);
    }
  }

  // 字幕テキストを Markdown に埋め込む
  let subFiles: string[] = [];
  try {
    subFiles = (await readdir(subsDir)).filter((f) => f.endsWith(".vtt"));
  } catch {
    // 字幕なし
  }

  if (subFiles.length > 0) {
    for (const f of subFiles) {
      const lang = f.match(/\.([a-z-]+)\.vtt$/i)?.[1] ?? f;
      const vtt = await readFile(join(subsDir, f), "utf-8").catch(() => null);
      if (!vtt) continue;
      const text = parseVtt(vtt);
      if (text) lines.push("", `## 字幕 (${lang})`, "", text);
    }
  } else {
    lines.push("", "## 字幕", "", "(取得できませんでした)");
  }

  return lines.join("\n");
}

/** GitHub REST API レスポンス + README を Markdown サマリーに変換する */
export async function buildGitHubMarkdown(
  repoJsonPath: string,
  readmePath: string,
): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(repoJsonPath, "utf-8");
  } catch {
    return "(GitHub JSON の読み込みに失敗しました)";
  }

  let repo: Record<string, unknown>;
  try {
    repo = JSON.parse(raw);
  } catch {
    return `(JSON パース失敗)\n\n${raw.slice(0, 2000)}`;
  }

  const str = (k: string) =>
    typeof repo[k] === "string" ? (repo[k] as string) : "";
  const num = (k: string) =>
    typeof repo[k] === "number" ? (repo[k] as number) : null;

  const lines: string[] = [];

  const fullName = str("full_name");
  lines.push(`# ${fullName || "(不明)"}`);
  lines.push("");

  const description = str("description");
  if (description) {
    lines.push(description);
    lines.push("");
  }

  const language = str("language") || "Unknown";
  const license =
    (repo.license as Record<string, string> | null)?.name ?? "No License";
  const stars = num("stargazers_count") ?? 0;
  const forks = num("forks_count") ?? 0;
  const issues = num("open_issues_count") ?? 0;

  lines.push(
    `**Language**: ${language} | **License**: ${license} | **Stars**: ${stars.toLocaleString()} | **Forks**: ${forks.toLocaleString()} | **Open Issues**: ${issues.toLocaleString()}`,
  );

  const topics = repo.topics as string[] | undefined;
  if (Array.isArray(topics) && topics.length > 0) {
    lines.push(`**Topics**: ${topics.join(", ")}`);
  }

  const homepage = str("homepage");
  if (homepage) lines.push(`**Homepage**: ${homepage}`);

  const isFork = repo.fork ? "Yes" : "No";
  lines.push(
    `**Fork**: ${isFork} | **Created**: ${str("created_at")} | **Updated**: ${str("updated_at")}`,
  );
  lines.push(`**URL**: https://github.com/${fullName}`);
  lines.push("", "---", "");

  let readme: string | null = null;
  try {
    readme = await readFile(readmePath, "utf-8");
  } catch {
    // README が存在しない
  }

  if (readme) {
    lines.push("## README", "", readme);
  } else {
    lines.push("*(README not found)*");
  }

  return lines.join("\n");
}

/** Reddit JSON API レスポンスを Markdown サマリーに変換する */
export async function buildRedditMarkdown(absPath: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(absPath, "utf-8");
  } catch {
    return "(Reddit JSON の読み込みに失敗しました)";
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return `(JSON パース失敗)\n\n${raw.slice(0, 2000)}`;
  }

  const lines: string[] = [];

  // スレッド詳細: [{post listing}, {comments listing}]
  if (Array.isArray(data) && data.length >= 1) {
    const postListing = (data[0] as Record<string, unknown>)?.data as Record<
      string,
      unknown
    >;
    const postChildren = postListing?.children as Array<
      Record<string, unknown>
    >;
    const post = postChildren?.[0]?.data as Record<string, unknown> | undefined;

    if (post) {
      lines.push(`# ${post.title ?? "(タイトル不明)"}`);
      lines.push("");
      lines.push(
        `**r/${post.subreddit}** | u/${post.author} | スコア: ${post.score} | コメント: ${post.num_comments}`,
      );

      const created = post.created_utc;
      if (typeof created === "number") {
        lines.push(
          `**投稿日**: ${new Date(created * 1000).toISOString().slice(0, 10)}`,
        );
      }

      const selftext = post.selftext as string | undefined;
      if (selftext && selftext !== "[removed]" && selftext !== "[deleted]") {
        lines.push("", "## 本文", "", selftext);
      }

      // コメント
      if (data[1] != null && typeof data[1] === "object") {
        const commentListing = (data[1] as unknown as Record<string, unknown>)
          ?.data as Record<string, unknown>;
        const comments = (
          commentListing?.children as Array<Record<string, unknown>>
        )?.filter((c) => c.kind === "t1");

        if (comments?.length) {
          lines.push("", "## トップコメント", "");
          for (const c of comments) {
            const cd = c.data as Record<string, unknown>;
            const body = (cd.body as string | undefined) ?? "";
            lines.push(`**u/${cd.author}** (スコア: ${cd.score})`);
            lines.push(body);
            lines.push("");
          }
        }
      }

      return lines.join("\n");
    }
  }

  // サブレディット一覧: {kind: "Listing", data: {children: [...]}}
  const listing = (data as Record<string, unknown>)?.data as
    | Record<string, unknown>
    | undefined;
  const children = listing?.children as
    | Array<Record<string, unknown>>
    | undefined;
  if (children?.length) {
    lines.push("# 投稿一覧", "");
    for (const child of children) {
      const p = child.data as Record<string, unknown>;
      lines.push(`## ${p.title}`);
      lines.push(
        `u/${p.author} | スコア: ${p.score} | コメント: ${p.num_comments}`,
      );
      lines.push(`URL: ${p.url}`);
      lines.push("");
    }
    return lines.join("\n");
  }

  return `(Reddit レスポンスの構造を解析できませんでした)\n\n${raw.slice(0, 1000)}`;
}

/** fxtwitter API レスポンスを Markdown サマリーに変換する */
export async function buildXTwitterMarkdown(absPath: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(absPath, "utf-8");
  } catch {
    return "(X/Twitter JSON の読み込みに失敗しました)";
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return `(JSON パース失敗)\n\n${raw.slice(0, 2000)}`;
  }

  const d = data as Record<string, unknown>;
  const code = typeof d.code === "number" ? d.code : null;
  if (code !== null && code !== 200) {
    const message = typeof d.message === "string" ? d.message : "unknown error";
    return `(fxtwitter API エラー: ${code} ${message})`;
  }

  const tweet = d.tweet as Record<string, unknown> | undefined;
  if (!tweet) {
    return `(X/Twitter レスポンスの構造を解析できませんでした)\n\n${raw.slice(0, 1000)}`;
  }

  const str = (k: string) =>
    typeof tweet[k] === "string" ? (tweet[k] as string) : "";
  const num = (k: string) =>
    typeof tweet[k] === "number" ? (tweet[k] as number) : null;

  const author = tweet.author as Record<string, unknown> | undefined;
  const screenName =
    typeof author?.screen_name === "string" ? author.screen_name : "";
  const authorName =
    typeof author?.name === "string" ? author.name : screenName;

  const lines: string[] = [];

  lines.push(`# @${screenName} (${authorName})`);
  lines.push("");
  lines.push(str("text"));
  lines.push("");

  const createdAt = str("created_at");
  if (createdAt) lines.push(`**投稿日時**: ${createdAt}`);

  const likes = num("likes");
  if (likes !== null) lines.push(`**いいね**: ${likes.toLocaleString()}`);

  const retweets = num("retweets");
  if (retweets !== null)
    lines.push(`**リツイート**: ${retweets.toLocaleString()}`);

  const replies = num("replies");
  if (replies !== null) lines.push(`**返信**: ${replies.toLocaleString()}`);

  const views = num("views");
  if (views !== null) lines.push(`**表示回数**: ${views.toLocaleString()}`);

  return lines.join("\n");
}

export function buildCommand(
  service: ServiceType,
  url: string,
  outAbsPath: string,
): string {
  const out = shellQuote(outAbsPath);
  switch (service) {
    case "youtube": {
      const q = shellQuote(url);
      // outAbsPath = /workspace/fetched/youtube-xxx.md
      // base      = /workspace/fetched/youtube-xxx  (拡張子なし)
      const base = outAbsPath.replace(/\.[^.]+$/, "");
      const metaOutQ = shellQuote(`${base}.meta.json`);
      const subDirQ = shellQuote(`${base}.subs`);
      return (
        `mkdir -p ${subDirQ} && ` +
        `yt-dlp --no-check-certificate --dump-json ${q} > ${metaOutQ} 2>&1 && ` +
        `(yt-dlp --no-check-certificate --write-auto-subs --sub-lang ja,en --skip-download -o ${shellQuote(`${base}.subs/%(id)s`)} ${q} > /dev/null 2>&1 || true)`
      );
    }
    case "github-repo": {
      const m = new URL(url).pathname.match(/^\/([^/]+)\/([^/]+)/);
      if (!m)
        throw new Error(`GitHub URL からリポジトリを取得できません: ${url}`);
      const apiBase = `https://api.github.com/repos/${m[1]}/${m[2]}`;
      const base = outAbsPath.replace(/\.[^.]+$/, "");
      const repoJsonQ = shellQuote(`${base}.repo.json`);
      const readmeQ = shellQuote(`${base}.readme.md`);
      return (
        `curl -sS -o ${repoJsonQ} -w '%{http_code}' -H "Accept: application/vnd.github.v3+json" ${shellQuote(apiBase)} && ` +
        // README は -sf のまま維持: 404時にファイル自体を作らせず、buildGitHubMarkdown の
        // 「README not found」分岐に委ねる（エラーレスポンス本文をREADMEとして埋め込まないため）
        `(curl -sf -H "Accept: application/vnd.github.v3.raw" ${shellQuote(`${apiBase}/readme`)} > ${readmeQ} 2>/dev/null || true)`
      );
    }
    case "x-twitter": {
      const m = new URL(url).pathname.match(/\/([^/]+)\/status\/(\d+)/);
      if (!m)
        throw new Error(`X/Twitter URL からツイートIDを取得できません: ${url}`);
      const [, username, tweetId] = m;
      return `curl -sS -o ${out} -w '%{http_code}' ${shellQuote(`https://api.fxtwitter.com/${username}/status/${tweetId}`)}`;
    }
    case "reddit": {
      // Reddit は未認証アクセスを一律ブロックするため、credential-proxy 経由で
      // ログイン済みクッキー(www.reddit.com)を使ってアクセスする
      // (docs/reddit-cookie-setup.md 参照)
      const parsed = new URL(url);
      const jsonPath = parsed.pathname.endsWith(".json")
        ? parsed.pathname
        : `${parsed.pathname.replace(/\/+$/, "")}.json`;
      const proxyUrl = `${resolveProxyBaseUrl("reddit")}${jsonPath}${parsed.search}`;
      return `curl -sS -o ${out} -w '%{http_code}' ${shellQuote(proxyUrl)} -H "User-Agent: ${REDDIT_USER_AGENT}"`;
    }
    case "rss":
      return (
        `python3 -c ` +
        shellQuote(
          `import feedparser,json,sys; f=feedparser.parse(sys.argv[1]); ` +
            `print(json.dumps([{'title':e.title,'link':e.link,'summary':getattr(e,'summary','')} for e in f.entries[:20]], ensure_ascii=False, indent=2))`,
        ) +
        ` ${shellQuote(url)} > ${out}`
      );
    default:
      return `curl -sS -o ${out} -w '%{http_code}' ${shellQuote(`https://r.jina.ai/${url}`)}`;
  }
}

/** buildCommand が `-w '%{http_code}'` で HTTP ステータスコードを stdout に出力するサービス */
const HTTP_STATUS_SERVICES: ReadonlySet<ServiceType> = new Set([
  "web",
  "x-twitter",
  "reddit",
  "github-repo",
]);

/** curl の `-w '%{http_code}'` 出力（stdout）から HTTP ステータスコードを取り出す */
export function parseHttpStatus(stdout: string): number | null {
  const status = Number.parseInt(stdout.trim(), 10);
  // curl は応答を受け取れなかった場合 %{http_code} に "000" を出力する。
  // 0 は有効なHTTPステータスではないため null とする。
  return Number.isFinite(status) && status > 0 ? status : null;
}

/** HTTPエラー時、curl がレスポンス本文を書き出したファイルのパスを返す */
export function getHttpErrorBodyPath(
  service: ServiceType,
  absPath: string,
): string {
  // github-repo はレスポンス本文を absPath ではなく {base}.repo.json に書き出す
  if (service === "github-repo") {
    return `${absPath.replace(/\.[^.]+$/, "")}.repo.json`;
  }
  return absPath;
}

/** HTTPエラーをエージェントに伝えるメッセージを組み立てる */
export function formatHttpError(
  status: number,
  url: string,
  body: string,
): string {
  const header = `HTTPエラー ${status} (${url})`;
  const truncated = body.slice(0, 500).trim();
  return truncated ? `${header}\n${truncated}` : header;
}

/**
 * このツールコールが作成しうる中間ファイル/ディレクトリの一覧を返す。
 * absPath は呼び出しごとに randomUUID を含み一意なので、これらを個別削除しても
 * 並行実行中の他のツールコールには影響しない（共有ディレクトリ自体は消さない）。
 */
export function getCleanupPaths(
  service: ServiceType,
  absPath: string,
): string[] {
  const base = absPath.replace(/\.[^.]+$/, "");
  switch (service) {
    case "youtube":
      return [absPath, `${base}.meta.json`, `${base}.subs`];
    case "github-repo":
      return [absPath, `${base}.repo.json`, `${base}.readme.md`];
    default:
      return [absPath];
  }
}

const parameters = Type.Object({
  url: Type.String({ description: "取得するURL" }),
});

export const agentReachTool: AgentTool<typeof parameters> = {
  name: "agent-reach",
  label: "Agent Reach",
  description:
    "youtube, github, reddit, x, rss, webページの情報を取得してmarkdownとして返す。左のサービスのURLから情報を取得するときは必ず使うこと。",
  parameters,
  execute: async (_toolCallId, { url }) => {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`許可されていないプロトコル: ${parsed.protocol}`);
    }
    // TOCTOU: ここで解決したIPと curl/yt-dlp が実際に接続するIPは異なる可能性がある
    // （DNS リバインディング）。サンドボックス内実行のため影響は限定的だが既知のリスク。
    const addresses = await lookup(parsed.hostname, { all: true });
    const blocked = addresses.find((a) => isPrivateAddress(a.address));
    if (blocked) {
      throw new Error(`内部アドレスへのアクセスは禁止: ${blocked.address}`);
    }

    const service = detectService(parsed);
    const tmpDirAbs = join(WORKSPACE, TMP_DIR);
    const absPath = join(tmpDirAbs, `${service}-${randomUUID().slice(0, 8)}.md`);

    await mkdir(tmpDirAbs, { recursive: true });

    try {
      const cmd = buildCommand(service, url, absPath);
      let stdout: string;
      try {
        ({ stdout } = await execAsync(cmd, {
          timeout: TIMEOUT_MS,
          maxBuffer: 64 * 1024 * 1024,
          cwd: WORKSPACE,
        }));
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        throw new Error(
          [e.stdout, e.stderr, e.message].filter(Boolean).join("\n").trim() ||
            "フェッチ失敗",
        );
      }

      if (HTTP_STATUS_SERVICES.has(service)) {
        const status = parseHttpStatus(stdout);
        if (status !== null && status >= 400) {
          const bodyPath = getHttpErrorBodyPath(service, absPath);
          const body = await readFile(bodyPath, "utf-8").catch(() => "");
          throw new Error(formatHttpError(status, url, body));
        }
      }

      // YouTube / GitHub / Reddit / X: 生データ → Markdown サマリーに変換
      let content: string;
      if (service === "youtube") {
        const base = absPath.replace(/\.[^.]+$/, "");
        content = await buildYouTubeMarkdown(`${base}.meta.json`, `${base}.subs`);
      } else if (service === "github-repo") {
        const base = absPath.replace(/\.[^.]+$/, "");
        content = await buildGitHubMarkdown(
          `${base}.repo.json`,
          `${base}.readme.md`,
        );
      } else if (service === "x-twitter") {
        content = await buildXTwitterMarkdown(absPath);
      } else if (service === "reddit") {
        content = await buildRedditMarkdown(absPath);
      } else {
        content = await readFile(absPath, "utf-8").catch(() => "");
      }

      return {
        content: [{ type: "text", text: content }],
        details: { url, service },
      };
    } finally {
      await Promise.all(
        getCleanupPaths(service, absPath).map((p) =>
          rm(p, { recursive: true, force: true }),
        ),
      );
    }
  },
};
