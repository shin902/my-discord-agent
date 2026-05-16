import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const WORKSPACE = "/workspace";
const FETCH_DIR = "fetched";
const TIMEOUT_MS = 120_000;

const PRIVATE_IP = [
  /^127\./,
  /^169\.254\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^::1$/,
  /^fc00:/,
  /^fe80:/,
];

function isPrivateAddress(ip: string): boolean {
  return PRIVATE_IP.some((r) => r.test(ip));
}

function shellQuote(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

type ServiceType = "youtube" | "github-repo" | "reddit" | "rss" | "web";

export function detectService(parsed: URL): ServiceType {
  const host = parsed.hostname.replace(/^www\./, "");
  if (host === "youtube.com" || host === "youtu.be") return "youtube";
  if (host === "github.com" && /^\/[^/]+\/[^/]+/.test(parsed.pathname))
    return "github-repo";
  if (host === "reddit.com") return "reddit";
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

/** yt-dlp の巨大 JSON を Markdown サマリーに変換する */
async function buildYouTubeMarkdown(
  metaJsonPath: string,
  subsDir: string,
  relSubsDir: string,
): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(metaJsonPath, "utf-8");
  } catch {
    return "(メタデータの読み込みに失敗しました)";
  }

  // yt-dlp は先頭に WARNING 行を出すことがある。JSON 部分だけ抽出する。
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1) return `(JSON が見つかりません)\n\n${raw.slice(0, 2000)}`;

  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(raw.slice(jsonStart));
  } catch {
    return `(JSON パース失敗)\n\n${raw.slice(jsonStart, jsonStart + 2000)}`;
  }

  const str = (k: string) => (typeof meta[k] === "string" ? (meta[k] as string) : "");
  const num = (k: string) => (typeof meta[k] === "number" ? (meta[k] as number) : null);

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
  if (duration !== null) lines.push(`**再生時間**: ${formatDuration(duration)}`);

  const views = num("view_count");
  if (views !== null) lines.push(`**視聴回数**: ${views.toLocaleString()}`);

  const likes = num("like_count");
  if (likes !== null) lines.push(`**いいね**: ${likes.toLocaleString()}`);

  const tags = meta["tags"];
  if (Array.isArray(tags) && tags.length > 0) {
    lines.push(`**タグ**: ${(tags as string[]).slice(0, 10).join(", ")}`);
  }

  const desc = str("description");
  if (desc) {
    lines.push("", "## 説明", "", desc.slice(0, 1000));
    if (desc.length > 1000) lines.push(`\n...(省略: 全${desc.length}文字)`);
  }

  const chapters = meta["chapters"];
  if (Array.isArray(chapters) && chapters.length > 0) {
    lines.push("", "## チャプター", "");
    for (const ch of chapters as Array<Record<string, unknown>>) {
      const t = typeof ch["start_time"] === "number" ? formatDuration(ch["start_time"] as number) : "?";
      lines.push(`- ${t} ${ch["title"] ?? ""}`);
    }
  }

  // 字幕ファイル一覧
  let subFiles: string[] = [];
  try {
    const { readdir } = await import("node:fs/promises");
    subFiles = await readdir(subsDir);
  } catch {
    // 字幕なし
  }

  if (subFiles.length > 0) {
    lines.push("", "## 字幕ファイル", "");
    for (const f of subFiles) {
      lines.push(`- ${relSubsDir}/${f}`);
    }
  } else {
    lines.push("", "## 字幕", "", "(取得できませんでした)");
  }

  return lines.join("\n");
}

function buildCommand(
  service: ServiceType,
  url: string,
  outAbsPath: string,
): string {
  const out = shellQuote(outAbsPath);
  switch (service) {
    case "youtube": {
      const q = shellQuote(url);
      const metaOutQ = shellQuote(`${outAbsPath}.meta.json`);
      const subDirQ = shellQuote(`${outAbsPath}.subs`);
      return (
        `mkdir -p ${subDirQ} && ` +
        `(yt-dlp --no-check-certificate --dump-json ${q} > ${metaOutQ} 2>&1 || true) && ` +
        `(yt-dlp --no-check-certificate --write-auto-subs --sub-lang ja,en --skip-download -o ${shellQuote(`${outAbsPath}.subs/%(id)s`)} ${q} > /dev/null 2>&1 || true)`
      );
    }
    case "github-repo": {
      const m = new URL(url).pathname.match(/^\/([^/]+)\/([^/]+)/);
      const repoSlug = m ? `${m[1]}/${m[2]}` : "";
      return `gh repo view ${shellQuote(repoSlug)} > ${out} 2>&1`;
    }
    case "reddit": {
      const jsonUrl = url.endsWith(".json")
        ? url
        : url.replace(/\/?(\?.*)?$/, (s) => `.json${s}`);
      return `curl -sf ${shellQuote(jsonUrl)} -H "User-Agent: discord-agent/1.0" > ${out}`;
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
    case "web":
    default:
      return `curl -sf ${shellQuote(`https://r.jina.ai/${url}`)} > ${out}`;
  }
}

function execAsync(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      { timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, cwd: WORKSPACE },
      (err, stdout, stderr) => {
        if (err) {
          Object.assign(err, { stdout, stderr });
          reject(err);
        } else {
          resolve();
        }
      },
    );
  });
}

const parameters = Type.Object({
  url: Type.String({ description: "取得するURL" }),
});

export const urlFetchTool: AgentTool<typeof parameters> = {
  name: "url-fetch",
  label: "URL Fetch to File",
  description:
    "URLのサービスを自動検出してコンテンツをファイルに保存し、ワークスペース相対パスを返す。read ツールで内容を確認すること",
  parameters,
  execute: async (_toolCallId, { url }) => {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`許可されていないプロトコル: ${parsed.protocol}`);
    }
    const { address } = await lookup(parsed.hostname);
    if (isPrivateAddress(address)) {
      throw new Error(`内部アドレスへのアクセスは禁止: ${address}`);
    }

    const service = detectService(parsed);
    const ext = service === "youtube" ? "md" : service === "github-repo" ? "txt" : "md";
    const filename = `${service}-${randomUUID().slice(0, 8)}.${ext}`;
    const relPath = `${FETCH_DIR}/${filename}`;
    const absPath = join(WORKSPACE, relPath);

    await mkdir(join(WORKSPACE, FETCH_DIR), { recursive: true });

    const cmd = buildCommand(service, url, absPath);
    try {
      await execAsync(cmd);
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      throw new Error(
        [e.stdout, e.stderr, e.message].filter(Boolean).join("\n").trim() ||
          "フェッチ失敗",
      );
    }

    // YouTube: 巨大 JSON → Markdown サマリーに変換して保存
    if (service === "youtube") {
      const metaJson = `${absPath}.meta.json`;
      const subsDir = `${absPath}.subs`;
      const relSubsDir = `${relPath}.subs`;
      const md = await buildYouTubeMarkdown(metaJson, subsDir, relSubsDir);
      await writeFile(absPath, md, "utf-8");
    }

    const content = await readFile(absPath, "utf-8").catch(() => "");
    const sizeKb = (Buffer.byteLength(content, "utf-8") / 1024).toFixed(1);

    return {
      content: [
        {
          type: "text",
          text: `保存完了\nパス: ${relPath}\nサービス: ${service}\nサイズ: ${sizeKb} KB\nread ツールで内容を確認してください`,
        },
      ],
      details: { url, service, path: relPath },
    };
  },
};
