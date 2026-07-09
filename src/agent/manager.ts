import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentTimeoutMs } from "../config/agent-config.js";
import { loadCredentialProxy } from "../config/credential-proxy.js";
import { resolveModelConfig } from "../config/default-model.js";
import { ensureGroupSkills } from "../config/group-config.js";
import {
  type AgentConfig,
  findGroupByName,
  type GroupConfig,
  type MountConfig,
} from "../config/groups.js";
import type { AttachmentRef } from "../queue/inbox.js";
import { resolveTools } from "../tools/registry.js";
import { NonRetryableError, TransientError } from "../utils/error.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../../");

import { resolveBaseUrl, resolveModel, validateModel } from "./model.js";

export { resolveBaseUrl, resolveModel, validateModel };

export type DiscordEvent =
  | { type: "tool_start"; toolName: string; args?: unknown }
  | { type: "error"; message: string };

export interface AgentTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

interface AgentTimingEvent {
  type: "agent_timing";
  promptMs: number;
  assistantTurns: number;
  usage?: AgentTokenUsage;
  stopReason?: string;
}

export interface AgentExecutionTiming {
  termination: "close" | "timeout" | "spawn-error";
  exitCode?: number | null;
  preparationMs: number;
  dockerRunMs: number;
  imagePullMs?: number;
  containerAndAgentMs?: number;
  promptMs?: number;
  postPromptMs?: number;
  assistantTurns?: number;
  usage?: AgentTokenUsage;
  stopReason?: string;
}

const DISCORD_EVENT_PREFIX = "__DISCORD_EVENT__:";
const RUNNER_IMAGE = "localhost:5050/my-discord-agent-runner:latest";

function formatTimeoutLabel(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}分`;
  return `${ms / 1000}秒`;
}

let storedProxyPort: number | null = null;

// Bot プロセス自体の再起動・停止時、実行中の docker run 子プロセスは自動では
// kill されず孤立しうる（Linux では init に reparent されて動き続ける）。
// シャットダウンハンドラーから確実に停止できるよう、コンテナ名と対応する
// docker run クライアントプロセスの両方を保持する。
// `--pull=always` によるイメージ pull 中はコンテナがまだ作られていないため
// `docker kill <name>` だけでは何も止められない。クライアントプロセス自体も
// 直接 kill することで、pull 中・コンテナ起動後どちらのフェーズでも確実に止める。
const runningContainers = new Map<string, ChildProcess>();

/**
 * 実行中の全エージェントコンテナ（および対応する docker run クライアント
 * プロセス）を停止する。SIGTERM/SIGINT 受信時に index.ts から呼び出される想定。
 */
export function killAllRunningContainers(): Promise<void> {
  const entries = [...runningContainers.entries()];
  if (entries.length === 0) return Promise.resolve();
  console.error(
    `[manager] シャットダウン: 実行中のコンテナ ${entries.length} 件を停止します`,
    entries.map(([name]) => name),
  );
  return Promise.all(
    entries.map(([name, proc]) => {
      // pull 中でコンテナがまだ存在しない場合に備え、クライアントプロセスも直接殺す。
      // コンテナが既に起動済みの場合はクライアント kill だけでは止まらないため
      // docker kill も併用する（無関係な場合は失敗するだけで無害）。
      proc.kill("SIGKILL");
      return new Promise<void>((resolve) => {
        const killProc = spawn("docker", ["kill", name], {
          stdio: "ignore",
        });
        killProc.on("close", () => resolve());
        killProc.on("error", () => resolve());
      });
    }),
  ).then(() => {
    // proc の close イベントでも削除されるが、呼び出し元から見て
    // 「killAllRunningContainers 完了時点で registry が空」を保証するため明示的に消す
    for (const [name] of entries) {
      runningContainers.delete(name);
    }
  });
}

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
      redditCookie: _redditCookie,
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

export function buildExtraMountArgs(mounts: MountConfig[]): string[] {
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

// groupName ごとの mounts 解決結果（docker -v 引数）のキャッシュ。
// group-config.ts と同じ「起動時に1回だけロード、再起動まで反映されない」方針に合わせ、
// validateGroupConfig() が起動時に一度だけ計算してここに格納する。
const extraMountArgsCache = new Map<string, string[]>();

/**
 * 起動時バリデーション専用。グループ設定（model/tools/mounts）をまとめて検証し、
 * 無効な設定はスローして即クラッシュさせる。mounts の解決結果はキャッシュし、
 * sendMessage() からの再計算を避ける。
 */
export async function validateGroupConfig(
  group: GroupConfig,
  defaultModel: { provider: string; modelId: string },
): Promise<void> {
  await validateModel(
    group.model?.provider ?? defaultModel.provider,
    group.model?.modelId ?? defaultModel.modelId,
  );
  resolveTools(group.tools ?? []);
  extraMountArgsCache.set(group.name, buildExtraMountArgs(group.mounts ?? []));
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

export interface SendMessageOptions {
  onDiscordEvent?: (event: DiscordEvent) => void;
  attachments?: AttachmentRef[];
  onExecutionTiming?: (timing: AgentExecutionTiming) => void;
  configOverride?: Partial<AgentConfig>;
}

export function sendMessage(
  groupName: string,
  sessionId: string,
  content: string,
  options?: SendMessageOptions,
): Promise<string>;
export function sendMessage(
  groupName: string,
  sessionId: string,
  content: string,
  onDiscordEvent?: (event: DiscordEvent) => void,
  attachments?: AttachmentRef[],
  onExecutionTiming?: (timing: AgentExecutionTiming) => void,
): Promise<string>;
export async function sendMessage(
  groupName: string,
  sessionId: string,
  content: string,
  optionsOrOnDiscordEvent?:
    | SendMessageOptions
    | ((event: DiscordEvent) => void),
  legacyAttachments?: AttachmentRef[],
  legacyOnExecutionTiming?: (timing: AgentExecutionTiming) => void,
): Promise<string> {
  const isLegacyCall =
    typeof optionsOrOnDiscordEvent === "function" ||
    legacyAttachments !== undefined ||
    legacyOnExecutionTiming !== undefined;
  const options: SendMessageOptions = isLegacyCall
    ? {
        onDiscordEvent:
          typeof optionsOrOnDiscordEvent === "function"
            ? optionsOrOnDiscordEvent
            : undefined,
        attachments: legacyAttachments,
        onExecutionTiming: legacyOnExecutionTiming,
      }
    : (optionsOrOnDiscordEvent ?? {});
  const { onDiscordEvent, attachments, onExecutionTiming } = options;
  const executionStartedAt = Date.now();
  const groupsEntry = await findGroupByName(groupName);
  const baseConfig: AgentConfig = groupsEntry ?? {};
  const effectiveConfig: AgentConfig = {
    ...baseConfig,
    ...options.configOverride,
  };

  const resolvedModel = await resolveModelConfig(effectiveConfig.model);

  try {
    await validateModel(resolvedModel.provider, resolvedModel.modelId);
  } catch (err) {
    return `設定エラー: ${err instanceof Error ? err.message : "不明なエラー"}`;
  }

  try {
    resolveTools(effectiveConfig.tools ?? []);
  } catch (err) {
    return `設定エラー: ${err instanceof Error ? err.message : "不明なエラー"}`;
  }

  // mounts は validateGroupConfig() が起動時に検証・キャッシュ済みならそれを使う。
  // キャッシュに無い場合（未知のグループ名や、起動時検証を経ていない呼び出し）は
  // その場で再計算してフォールバックする。
  let extraMountArgs: string[];
  const cachedMountArgs = extraMountArgsCache.get(groupName);
  if (cachedMountArgs !== undefined) {
    extraMountArgs = cachedMountArgs;
  } else {
    try {
      extraMountArgs = buildExtraMountArgs(groupsEntry?.mounts ?? []);
    } catch (err) {
      return `設定エラー: ${err instanceof Error ? err.message : "不明なエラー"}`;
    }
  }

  await mkdir(path.join(ROOT, "groups", groupName), { recursive: true });
  if (
    options.configOverride?.skills !== undefined &&
    Array.isArray(effectiveConfig.skills)
  ) {
    await ensureGroupSkills(groupName, effectiveConfig.skills);
  }
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

  let promptContent = content;
  if (attachments && attachments.length > 0) {
    const saved = await downloadAttachments(groupName, sessionId, attachments);
    if (saved.length > 0) {
      const lines = saved.map(
        (f) =>
          `- ${f.relPath} (${f.contentType ?? "unknown"}, ${f.size} bytes)`,
      );
      const hasImage = saved.some((f) => f.contentType?.startsWith("image/"));
      const hint = hasImage
        ? "\n\n画像ファイルは read ツールでパスを指定すると内容を確認できます。"
        : "";
      promptContent = `${content}\n\n[添付ファイル]\n${lines.join("\n")}${hint}`;
    }
  }

  // 過去のメッセージで添付された分も含め、セッションの添付ディレクトリがあれば
  // 常にマウントする（エージェントは1メッセージごとに使い捨てコンテナで起動するため）
  const attachmentsDir = path.join(
    ROOT,
    "data/attachments",
    groupName,
    sessionId,
  );
  let attachmentMountArgs: string[] = [];
  try {
    const entries = await readdir(attachmentsDir);
    if (entries.length > 0) {
      attachmentMountArgs = [
        "-v",
        `${attachmentsDir}:/workspace/attachments:ro`,
      ];
    }
  } catch {
    // ディレクトリが存在しない場合はマウントしない
  }

  const payload = JSON.stringify({
    groupName,
    sessionId,
    content: promptContent,
    groupConfig: { ...effectiveConfig, model: resolvedModel },
  });

  // docker run --rm はクライアントプロセスを SIGKILL してもコンテナ本体を止めない
  // （デーモンが管理しているため）。タイムアウト時に `docker kill` で実体を止められるよう
  // 一意なコンテナ名を明示的に付与する。
  const containerName =
    `my-discord-agent-${groupName}-${sessionId}-${executionStartedAt}`.replace(
      /[^a-zA-Z0-9_.-]/g,
      "-",
    );

  const args = [
    "run",
    "--rm",
    "-i",
    "--pull=always",
    "--name",
    containerName,
    "--memory=512m",
    "--cpus=1",
    "--user",
    `${process.getuid?.()}:${process.getgid?.()}`,
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
    "HOME=/tmp",
    "-e",
    `CREDENTIAL_PROXY_JSON=${credentialJson}`,
    RUNNER_IMAGE,
    "node",
    "/app/runner.mjs",
  ];

  const agentTimeoutMs = await loadAgentTimeoutMs();
  const dockerStartedAt = Date.now();
  return new Promise((resolve, reject) => {
    const proc = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    runningContainers.set(containerName, proc);

    let stdout = "";
    let stderrTail = "";
    let plainStderr = "";
    let pullCompletedAt: number | undefined;
    let agentTiming: AgentTimingEvent | undefined;
    let agentTimingReceivedAt: number | undefined;
    let timingReported = false;

    const reportExecutionTiming = (
      finishedAt: number,
      termination: AgentExecutionTiming["termination"],
      exitCode?: number | null,
    ): void => {
      if (timingReported) return;
      timingReported = true;
      const timing: AgentExecutionTiming = {
        termination,
        ...(exitCode !== undefined ? { exitCode } : {}),
        preparationMs: dockerStartedAt - executionStartedAt,
        dockerRunMs: finishedAt - dockerStartedAt,
        ...(pullCompletedAt !== undefined
          ? {
              imagePullMs: pullCompletedAt - dockerStartedAt,
              containerAndAgentMs: finishedAt - pullCompletedAt,
            }
          : {}),
        ...(agentTiming !== undefined
          ? {
              promptMs: agentTiming.promptMs,
              assistantTurns: agentTiming.assistantTurns,
              usage: agentTiming.usage,
              stopReason: agentTiming.stopReason,
              ...(agentTimingReceivedAt !== undefined
                ? {
                    postPromptMs: Math.max(
                      0,
                      finishedAt - agentTimingReceivedAt,
                    ),
                  }
                : {}),
            }
          : {}),
      };
      try {
        onExecutionTiming?.(timing);
      } catch (err) {
        console.error("[manager] 実行時間コールバックでエラー:", err);
      }
    };

    const processStderrLine = (line: string): void => {
      if (line.startsWith(DISCORD_EVENT_PREFIX)) {
        try {
          const event = JSON.parse(line.slice(DISCORD_EVENT_PREFIX.length)) as
            | DiscordEvent
            | AgentTimingEvent;
          if (event.type === "agent_timing") {
            agentTiming = event;
            agentTimingReceivedAt = Date.now();
          } else {
            onDiscordEvent?.(event);
          }
        } catch {
          // ignore malformed events
        }
      } else {
        // docker run --pull=always は pull 完了時に Status 行を出力する。
        // ここを境界にして、image pull とコンテナ内処理の所要時間を分離する。
        const dockerPullCompleted =
          line === `Status: Image is up to date for ${RUNNER_IMAGE}` ||
          line === `Status: Downloaded newer image for ${RUNNER_IMAGE}`;
        if (pullCompletedAt === undefined && dockerPullCompleted) {
          pullCompletedAt = Date.now();
        }
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

    const timeout = setTimeout(() => {
      if (stderrTail) {
        processStderrLine(stderrTail);
        stderrTail = "";
      }
      reportExecutionTiming(Date.now(), "timeout");
      proc.kill("SIGKILL");
      // docker run クライアントを殺してもコンテナ本体（デーモン管理）は生き続けるため、
      // --name で付与した一意な名前を使い docker kill でコンテナ本体を止める。
      // --rm 済みなので kill が通れば自動的に削除される。
      spawn("docker", ["kill", containerName], { stdio: "ignore" }).on(
        "error",
        () => {
          // 既にコンテナが終了している場合などは無視する
        },
      );
      reject(
        new NonRetryableError(
          `タイムアウト（${formatTimeoutLabel(agentTimeoutMs)}を超過しました）`,
        ),
      );
    }, agentTimeoutMs);

    proc.on("close", (code: number | null) => {
      clearTimeout(timeout);
      runningContainers.delete(containerName);
      // 残バッファをフラッシュ
      if (stderrTail) {
        processStderrLine(stderrTail);
        stderrTail = "";
      }
      reportExecutionTiming(Date.now(), "close", code);
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
      runningContainers.delete(containerName);
      reportExecutionTiming(Date.now(), "spawn-error");
      reject(err);
    });

    proc.stdin.write(payload);
    proc.stdin.end();
  });
}
