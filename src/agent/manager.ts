import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCredentialProxy } from "../config/credential-proxy.js";
import {
  type AgentConfig,
  findGroupByName,
  type MountConfig,
} from "../config/groups.js";
import type { AttachmentRef } from "../queue/inbox.js";
import { resolveTools } from "../tools/registry.js";
import { NonRetryableError, TransientError } from "../utils/error.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../../");

import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER,
  resolveBaseUrl,
  resolveModel,
  validateModel,
} from "./model.js";

export {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER,
  resolveBaseUrl,
  resolveModel,
  validateModel,
};

export type DiscordEvent =
  | { type: "tool_start"; toolName: string; args?: unknown }
  | { type: "error"; message: string };

const DISCORD_EVENT_PREFIX = "__DISCORD_EVENT__:";

let storedProxyPort: number | null = null;

export async function initManager(proxyPort: number): Promise<void> {
  storedProxyPort = proxyPort;
}

type CredentialEntry = Awaited<ReturnType<typeof loadCredentialProxy>>[number];

function buildSanitizedCredentialJson(
  creds: CredentialEntry[],
  proxyPort: number,
): string {
  const sanitized = [];
  for (const entry of creds) {
    const resolvedBaseUrl = resolveBaseUrl(entry.baseUrl);
    if (!resolvedBaseUrl) {
      console.warn(
        `[credential-proxy] ${entry.provider}: baseUrl に未解決のプレースホルダがあります（${entry.baseUrl}）`,
      );
      continue;
    }

    const envVars = entry.envVars ?? [];
    const setEnvVars = envVars.filter((name) => process.env[name]);
    if (envVars.length > 0 && setEnvVars.length === 0) continue;
    if (setEnvVars.length < envVars.length) {
      const missing = envVars.filter((name) => !process.env[name]);
      console.warn(
        `[credential-proxy] ${entry.provider}: 一部の環境変数が未設定です [設定済: ${setEnvVars.join(", ")}] [未設定: ${missing.join(", ")}]`,
      );
    }

    const {
      envVars: _ev,
      msal: _msal,
      google: _google,
      auth: _auth,
      ...rest
    } = entry;
    sanitized.push({
      ...rest,
      baseUrl: `http://host.docker.internal:${proxyPort}/${entry.provider}`,
    });
  }
  return JSON.stringify(sanitized);
}

const RESERVED_CONTAINER_PATHS = ["/workspace", "/sessions"];

function buildExtraMountArgs(mounts: MountConfig[]): string[] {
  const args: string[] = [];
  for (const mount of mounts) {
    if (
      RESERVED_CONTAINER_PATHS.some(
        (reserved) =>
          mount.container === reserved ||
          mount.container.startsWith(`${reserved}/`),
      )
    ) {
      throw new NonRetryableError(
        `mounts.container は予約済みパス (${RESERVED_CONTAINER_PATHS.join(", ")}) と重複できません: ${mount.container}`,
      );
    }
    let hostPath: string;
    if (path.isAbsolute(mount.host)) {
      hostPath = mount.host;
    } else {
      hostPath = path.join(ROOT, mount.host);
      const rel = path.relative(ROOT, hostPath);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new NonRetryableError(
          `mounts.host はリポジトリルート外を指しています: ${mount.host}`,
        );
      }
    }
    const suffix = mount.readOnly ? ":ro" : "";
    args.push("-v", `${hostPath}:${mount.container}${suffix}`);
  }
  return args;
}

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB

interface SavedAttachment {
  relPath: string;
  name: string;
  contentType: string | null;
  size: number;
}

// Discord の添付ファイル名から、コンテナにマウントしても安全なファイル名を作る
function sanitizeAttachmentName(name: string, index: number): string {
  const base = path
    .basename(name)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(-100);
  return `${index}-${base || "file"}`;
}

/**
 * 添付ファイルを data/attachments/{groupName}/{sessionId}/ にダウンロードする。
 * サイズ超過・件数超過・ダウンロード失敗のファイルはスキップする。
 */
async function downloadAttachments(
  groupName: string,
  sessionId: string,
  attachments: AttachmentRef[],
): Promise<SavedAttachment[]> {
  const dir = path.join(ROOT, "data/attachments", groupName, sessionId);
  await mkdir(dir, { recursive: true });

  const saved: SavedAttachment[] = [];
  for (const [index, att] of attachments.slice(0, MAX_ATTACHMENTS).entries()) {
    if (att.size > MAX_ATTACHMENT_BYTES) {
      console.warn(
        `[manager] 添付ファイルが大きすぎるためスキップ: ${att.name} (${att.size} bytes)`,
      );
      continue;
    }
    try {
      const res = await fetch(att.url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const safeName = sanitizeAttachmentName(att.name, index);
      await writeFile(path.join(dir, safeName), buf);
      saved.push({
        relPath: `attachments/${safeName}`,
        name: att.name,
        contentType: att.contentType,
        size: buf.length,
      });
    } catch (err) {
      console.error(
        `[manager] 添付ファイルのダウンロード失敗: ${att.name}`,
        err,
      );
    }
  }
  return saved;
}

export async function sendMessage(
  groupName: string,
  sessionId: string,
  content: string,
  onDiscordEvent?: (event: DiscordEvent) => void,
  attachments?: AttachmentRef[],
): Promise<string> {
  const groupsEntry = await findGroupByName(groupName);
  const groupConfig: AgentConfig = groupsEntry ?? {};

  try {
    await validateModel(
      groupConfig.model?.provider ?? DEFAULT_PROVIDER,
      groupConfig.model?.modelId ?? DEFAULT_MODEL_ID,
    );
  } catch (err) {
    return `設定エラー: ${err instanceof Error ? err.message : "不明なエラー"}`;
  }

  try {
    resolveTools(groupConfig.tools ?? []);
  } catch (err) {
    return `設定エラー: ${err instanceof Error ? err.message : "不明なエラー"}`;
  }

  let extraMountArgs: string[];
  try {
    extraMountArgs = buildExtraMountArgs(groupsEntry?.mounts ?? []);
  } catch (err) {
    return `設定エラー: ${err instanceof Error ? err.message : "不明なエラー"}`;
  }

  await mkdir(path.join(ROOT, "groups", groupName), { recursive: true });
  await mkdir(path.join(ROOT, "data/sessions", groupName), {
    recursive: true,
  });

  if (storedProxyPort === null) {
    throw new NonRetryableError(
      "credential proxy server が初期化されていません。initCredentialProxyServer() を initManager() より前に呼んでください",
    );
  }
  const proxyPort = storedProxyPort;

  const creds = await loadCredentialProxy();
  const credentialJson = buildSanitizedCredentialJson(creds, proxyPort);

  let attachmentMountArgs: string[] = [];
  let promptContent = content;
  if (attachments && attachments.length > 0) {
    const saved = await downloadAttachments(groupName, sessionId, attachments);
    if (saved.length > 0) {
      attachmentMountArgs = [
        "-v",
        `${path.join(ROOT, "data/attachments", groupName, sessionId)}:/workspace/attachments:ro`,
      ];
      const lines = saved.map(
        (f) =>
          `- ${f.relPath} (${f.contentType ?? "unknown"}, ${f.size} bytes)`,
      );
      promptContent = `${content}\n\n[添付ファイル]\n${lines.join("\n")}`;
    }
  }

  const payload = JSON.stringify({
    groupName,
    sessionId,
    content: promptContent,
    groupConfig,
  });

  const args = [
    "run",
    "--rm",
    "-i",
    "--pull=always",
    "--memory=512m",
    "--cpus=1",
    "--add-host=host.docker.internal:host-gateway",
    "-v",
    `${path.join(ROOT, "data/sessions", groupName)}:/sessions/${groupName}`,
    "-v",
    `${path.join(ROOT, "groups", groupName)}:/workspace`,
    ...attachmentMountArgs,
    ...extraMountArgs,
    "-e",
    "SESSIONS_DIR=/sessions",
    "-e",
    `CREDENTIAL_PROXY_JSON=${credentialJson}`,
    "localhost:5050/my-discord-agent-runner:latest",
    "node",
    "/app/runner.mjs",
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderrTail = "";
    let plainStderr = "";

    const processStderrLine = (line: string): void => {
      if (line.startsWith(DISCORD_EVENT_PREFIX)) {
        try {
          const event = JSON.parse(
            line.slice(DISCORD_EVENT_PREFIX.length),
          ) as DiscordEvent;
          onDiscordEvent?.(event);
        } catch {
          // ignore malformed events
        }
      } else {
        plainStderr += `${line}\n`;
      }
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrTail += chunk.toString();
      const lines = stderrTail.split("\n");
      stderrTail = lines.pop() ?? "";
      for (const line of lines) {
        processStderrLine(line);
      }
    });

    const timeout = setTimeout(
      () => {
        proc.kill("SIGKILL");
        reject(new NonRetryableError("タイムアウト（10分を超過しました）"));
      },
      10 * 60 * 1000,
    );

    proc.on("close", (code: number | null) => {
      clearTimeout(timeout);
      // 残バッファをフラッシュ
      if (stderrTail) {
        processStderrLine(stderrTail);
      }
      if (code === null) {
        // SIGKILL などシグナルで終了した場合。タイムアウト時は既に reject 済み
        return;
      }
      if (code === 0) {
        resolve(stdout.trim());
      } else if (code === 2) {
        reject(new TransientError(plainStderr.trim()));
      } else {
        resolve(`エージェント実行エラー: ${plainStderr.trim()}`);
      }
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.stdin.write(payload);
    proc.stdin.end();
  });
}
