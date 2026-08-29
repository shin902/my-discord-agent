import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentTimeoutMs } from "../config/agent-config.js";
import { resolveAgentConfig } from "../config/agent-resolution.js";
import { validateAgentConfig } from "../config/agent-validation.js";
import { loadCredentialProxy } from "../config/credential-proxy.js";
import { resolveModelConfig } from "../config/default-model.js";
import { ensureGroupSkills } from "../config/group-config.js";
import {
  type AgentConfig,
  findGroupByName,
  type GroupConfig,
} from "../config/groups.js";
import { buildExtraMountArgs } from "../config/mounts.js";
import { createInternalRequestConfig } from "../proxy/credential-proxy-server.js";
import type { AttachmentRef } from "../queue/types.js";
import { resolveTools } from "../tools/registry.js";
import { NonRetryableError, TransientError } from "../utils/error.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../../");

import { resolveBaseUrl, resolveModel, validateModel } from "./model.js";

export { resolveBaseUrl, resolveModel, validateModel };

export type AgentRunStatus = "running" | "completed" | "failed";

export type DiscordEvent =
  | { type: "tool_start"; toolName: string; args?: unknown }
  | { type: "error"; message: string }
  | {
      type: "subagent_tool_start";
      worker: "ephemeral";
      runId: string;
      parentRunId: string;
      toolName: string;
      taskPreview: string;
    }
  | {
      type: "subagent_update";
      worker: "ephemeral";
      runId: string;
      parentRunId: string;
      status: AgentRunStatus;
      taskPreview: string;
      resultPreview?: string;
    };

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
  systemPromptSnapshotHash?: string;
  memorySnapshotHash?: string;
  snapshotHash?: string;
  toolCallKey?: string;
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
  systemPromptSnapshotHash?: string;
  memorySnapshotHash?: string;
  snapshotHash?: string;
  toolCallKey?: string;
}

declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve: (value?: T | PromiseLike<T>) => void;
    };
  }
}
const DISCORD_EVENT_PREFIX = "__DISCORD_EVENT__:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return value === "running" || value === "completed" || value === "failed";
}

function isSafeSubagentPreview(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    !/[\r\n@]/.test(value)
  );
}

function isDiscordEvent(value: unknown): value is DiscordEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "tool_start":
      return typeof value.toolName === "string";
    case "error":
      return typeof value.message === "string";
    case "subagent_tool_start":
      return (
        value.worker === "ephemeral" &&
        typeof value.runId === "string" &&
        typeof value.parentRunId === "string" &&
        typeof value.toolName === "string" &&
        isSafeSubagentPreview(value.taskPreview, 120)
      );
    case "subagent_update":
      return (
        value.worker === "ephemeral" &&
        typeof value.runId === "string" &&
        typeof value.parentRunId === "string" &&
        isAgentRunStatus(value.status) &&
        isSafeSubagentPreview(value.taskPreview, 120) &&
        (value.resultPreview === undefined ||
          isSafeSubagentPreview(value.resultPreview, 200))
      );
    default:
      return false;
  }
}

function isAgentTimingEvent(value: unknown): value is AgentTimingEvent {
  return isRecord(value) && value.type === "agent_timing";
}

async function stopContainer(name: string): Promise<void> {
  const killResult = await new Promise<number>((resolve) => {
    const kill = spawn("docker", ["kill", name], { stdio: "ignore" });
    if (typeof kill.once !== "function") return resolve(0);
    kill.once("close", (code: number | null) => resolve(code ?? 1));
    kill.once("error", () => resolve(1));
  });
  const inspect = await new Promise<{ code: number; output: string }>(
    (resolve) => {
      const child = spawn("docker", ["inspect", name], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      if (typeof child.once !== "function") return resolve({ code: 1, output });
      child.once("close", (code: number | null) =>
        resolve({ code: code ?? 1, output }),
      );
      child.once("error", () => resolve({ code: 1, output }));
    },
  );
  if (
    inspect.code !== 0 &&
    !/no such (?:object|container)|not found/i.test(inspect.output)
  ) {
    throw new Error(
      `container cleanup inspect failed: ${name}: ${inspect.output.trim()}`,
    );
  }
  if (inspect.code === 0 && inspect.output.trim() !== "") {
    throw new Error(
      `container cleanup failed: ${name} still exists (kill=${killResult})`,
    );
  }
  if (killResult !== 0 && inspect.code === 0) {
    throw new Error(`container cleanup failed: ${name} kill=${killResult}`);
  }
}
const RUNNER_IMAGE = "localhost:5050/my-discord-agent-runner:latest";
const RUNNER_CONTAINER_LABEL = "my-discord-agent.runner=true";
const LEGACY_RUNNER_NAME_FILTER = "my-discord-agent-";
// Legacy runners predate the label, but their names still end with the
// execution-start timestamp. Inspect candidates before killing them so that
// similarly prefixed infrastructure containers (for example, the registry)
// are not treated as runners.
const LEGACY_RUNNER_NAME_PATTERN = /^my-discord-agent-.+-\d+$/;

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
export interface KillAllRunningContainersOptions {
  /** Also discover containers left by a previous host process. */
  includeOrphans?: boolean;
  /** Reject unless Docker proves discovery and termination succeeded. */
  strict?: boolean;
}

function resolveCleanupOptions(
  options: boolean | KillAllRunningContainersOptions,
): Required<KillAllRunningContainersOptions> {
  if (typeof options === "boolean")
    return { includeOrphans: options, strict: false };
  return {
    includeOrphans: options.includeOrphans ?? false,
    strict: options.strict ?? false,
  };
}

function discoverContainerIds(filter: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | undefined, stdout = "") => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(stdout.trim() ? stdout.trim().split(/\s+/) : []);
    };
    const child = execFile(
      "docker",
      ["ps", "-q", "--filter", filter],
      (error, stdout, stderr) => {
        if (error) {
          finish(
            new Error(
              `container cleanup discovery failed: ${stderr?.trim() || error.message}`,
            ),
          );
          return;
        }
        finish(undefined, stdout);
      },
    );
    child.on("error", (error) => finish(error));
  });
}

function inspectContainerNames(ids: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | undefined, stdout = "") => {
      if (settled) return;
      settled = true;
      if (error) {
        reject(error);
        return;
      }
      const names = stdout.trim() ? stdout.trim().split(/\s+/) : [];
      if (names.length !== ids.length) {
        reject(
          new Error(
            `container cleanup inspect returned ${names.length} name(s) for ${ids.length} container(s)`,
          ),
        );
        return;
      }
      resolve(names.map((name) => name.replace(/^\/+/, "")));
    };
    const child = execFile(
      "docker",
      ["inspect", "--format", "{{.Name}}", ...ids],
      (error, stdout, stderr) => {
        if (error) {
          finish(
            new Error(
              `container cleanup inspect failed: ${stderr?.trim() || error.message}`,
            ),
          );
          return;
        }
        finish(undefined, stdout);
      },
    );
    child.on("error", (error) => finish(error));
  });
}

async function discoverLegacyRunnerIds(): Promise<string[]> {
  const candidates = await discoverContainerIds(
    `name=${LEGACY_RUNNER_NAME_FILTER}`,
  );
  if (candidates.length === 0) return [];
  const names = await inspectContainerNames(candidates);
  return candidates.filter((_, index) =>
    LEGACY_RUNNER_NAME_PATTERN.test(names[index]),
  );
}

async function discoverManagedContainerIds(): Promise<string[]> {
  const labelled = await discoverContainerIds(
    `label=${RUNNER_CONTAINER_LABEL}`,
  );
  const legacy = await discoverLegacyRunnerIds();
  return [...new Set([...labelled, ...legacy])];
}

function killContainerIds(ids: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const killProc = spawn("docker", ["kill", ...ids], { stdio: "ignore" });
    const on =
      typeof killProc.once === "function"
        ? killProc.once.bind(killProc)
        : killProc.on.bind(killProc);
    on("close", (code: number | null) => {
      if (code === 0) resolve();
      else
        reject(new Error(`container cleanup kill failed: exit=${code ?? 1}`));
    });
    on("error", (error: Error) => reject(error));
  });
}

async function killOrphansStrict(): Promise<void> {
  const ids = await discoverManagedContainerIds();
  if (ids.length === 0) return;
  await killContainerIds(ids);
  const remaining = await discoverManagedContainerIds();
  if (remaining.length > 0)
    throw new Error(
      `container cleanup failed: ${remaining.length} managed container(s) remain`,
    );
}

async function killOrphansBestEffort(): Promise<void> {
  try {
    const ids = await discoverManagedContainerIds();
    if (ids.length > 0) await killContainerIds(ids);
  } catch {
    // Shutdown is best effort; startup uses killOrphansStrict instead.
  }
}

export function killAllRunningContainers(
  options: boolean | KillAllRunningContainersOptions = false,
): Promise<void> {
  const { includeOrphans, strict } = resolveCleanupOptions(options);
  const entries = [...runningContainers.entries()];
  const killManaged = includeOrphans
    ? strict
      ? killOrphansStrict()
      : killOrphansBestEffort()
    : Promise.resolve();
  const killTracked = Promise.all(
    entries.map(([name, proc]) => {
      // pull 中でコンテナがまだ存在しない場合に備え、クライアントプロセスも直接殺す。
      // コンテナが既に起動済みの場合はクライアント kill だけでは止まらないため
      // docker kill も併用する（無関係な場合は失敗するだけで無害）。
      proc.kill("SIGKILL");
      if (strict) return stopContainer(name);
      return new Promise<void>((resolve) => {
        const killProc = spawn("docker", ["kill", name], {
          stdio: "ignore",
        });
        killProc.on("close", () => resolve());
        killProc.on("error", () => resolve());
      });
    }),
  );
  return Promise.all([killManaged, killTracked]).then(() => {
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

export { buildExtraMountArgs } from "../config/mounts.js";

// groupName ごとの mounts 解決結果（docker -v 引数）のキャッシュ。
// group-config.ts と同じ「起動時に1回だけロード、再起動まで反映されない」方針に合わせ、
// validateGroupConfig() が起動時に一度だけ計算してここに格納する。
const extraMountArgsCache = new Map<string, string[]>();

/**
 * 起動時バリデーション専用。グループと各チャンネルの effective
 * AgentConfig（model/tools/mounts）を検証し、グループ既定の mounts はキャッシュする。
 */
export async function validateGroupConfig(
  group: GroupConfig,
  defaultModel: { provider: string; modelId: string },
): Promise<void> {
  await validateAgentConfig(resolveAgentConfig(group), defaultModel);
  await Promise.all(
    group.channels.map((channel) =>
      validateAgentConfig(resolveAgentConfig(group, channel), defaultModel),
    ),
  );
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
  onContainerStarted?: () => void | Promise<void>;
  signal?: AbortSignal;
  configOverride?: Partial<AgentConfig>;
  systemPromptSnapshotContent?: string;
  systemPromptSnapshotPresent?: boolean;
  memorySnapshotPresent?: boolean;
  memorySnapshotContent?: string;
  snapshotHash?: string;
  toolCallKey?: string;
  /** Request-scoped instructions appended to the sandbox system prompt. */
  systemPromptAppend?: string;
  /** Disable nested agent-facing Bot delegation for a Bot execution. */
  enableBotTool?: boolean;
  /** Provider whose serial LLM lock is held by the caller, if any. */
  heldLlmProvider?: string;
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
  const {
    onDiscordEvent,
    attachments,
    onExecutionTiming,
    onContainerStarted,
    signal,
    systemPromptSnapshotContent,
    systemPromptSnapshotPresent,
    memorySnapshotPresent,
    memorySnapshotContent,
    snapshotHash,
    toolCallKey,
    systemPromptAppend,
    enableBotTool,
    heldLlmProvider,
  } = options;
  const executionStartedAt = Date.now();
  const groupsEntry = await findGroupByName(groupName);
  const effectiveConfig = resolveAgentConfig(
    groupsEntry,
    options.configOverride,
  );

  const resolvedModel = await resolveModelConfig(effectiveConfig.model);

  try {
    await validateModel(resolvedModel.provider, resolvedModel.modelId);
  } catch (err) {
    throw new NonRetryableError(
      `設定エラー: ${err instanceof Error ? err.message : "不明なエラー"}`,
    );
  }

  try {
    resolveTools(effectiveConfig.tools ?? []);
  } catch (err) {
    throw new NonRetryableError(
      `設定エラー: ${err instanceof Error ? err.message : "不明なエラー"}`,
    );
  }

  // group既定のmountsは起動時キャッシュを使い、configOverrideを含む
  // effective値は必ずその場で検証してDocker引数へ変換する。
  let extraMountArgs: string[];
  const cachedMountArgs =
    options.configOverride?.mounts === undefined
      ? extraMountArgsCache.get(groupName)
      : undefined;
  if (cachedMountArgs !== undefined) {
    extraMountArgs = cachedMountArgs;
  } else {
    try {
      extraMountArgs = buildExtraMountArgs(effectiveConfig.mounts ?? []);
    } catch (err) {
      throw new NonRetryableError(
        `設定エラー: ${err instanceof Error ? err.message : "不明なエラー"}`,
      );
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

  const agentTimeoutMs = await loadAgentTimeoutMs();
  const internalRequest =
    enableBotTool !== false && effectiveConfig.tools?.includes("bot") === true
      ? createInternalRequestConfig?.(groupName, heldLlmProvider)
      : undefined;
  const payload = JSON.stringify({
    groupName,
    sessionId,
    content: promptContent,
    groupConfig: {
      ...effectiveConfig,
      model: resolvedModel,
      ...(groupsEntry?.allowMention !== undefined
        ? { allowMention: groupsEntry.allowMention }
        : {}),
      ...(groupsEntry?.toolLogArgs !== undefined
        ? { toolLogArgs: groupsEntry.toolLogArgs }
        : {}),
    },
    ...(systemPromptSnapshotContent !== undefined
      ? { systemPromptSnapshotContent }
      : {}),
    ...(systemPromptSnapshotPresent !== undefined
      ? { systemPromptSnapshotPresent }
      : {}),
    ...(memorySnapshotPresent !== undefined ? { memorySnapshotPresent } : {}),
    ...(memorySnapshotContent !== undefined ? { memorySnapshotContent } : {}),
    ...(snapshotHash !== undefined ? { snapshotHash } : {}),
    ...(toolCallKey !== undefined ? { toolCallKey } : {}),
    ...(systemPromptAppend !== undefined ? { systemPromptAppend } : {}),
    ...(enableBotTool !== false && internalRequest
      ? {
          botToolEndpoint: {
            url: `http://host.docker.internal:${internalRequest.port}/__agent/bot`,
            token: internalRequest.token,
          },
        }
      : {}),
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
    "--label",
    RUNNER_CONTAINER_LABEL,
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

  const dockerStartedAt = Date.now();
  return new Promise<string>((resolve, reject) => {
    const proc = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    runningContainers.set(containerName, proc);
    let timeoutHandle: NodeJS.Timeout | undefined;
    const cancelActiveRun = () => {
      if (cleanupActive) return;
      cleanupActive = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", cancelActiveRun);
      runningContainers.delete(containerName);
      proc.kill("SIGKILL");
      void stopContainer(containerName).then(
        () => reject(new TransientError("実行がキャンセルされました")),
        (error) =>
          reject(
            new NonRetryableError(
              `キャンセル後の後始末に失敗しました: ${String(error)}`,
            ),
          ),
      );
    };
    let cleanupActive = false;
    if (signal)
      signal.addEventListener("abort", cancelActiveRun, { once: true });
    if (signal?.aborted) cancelActiveRun();

    let stdout = "";
    let plainStderr = "";
    let stderrTail = "";
    let pullCompletedAt: number | undefined;
    let containerStartedReported = false;
    const requiresReadyHandshake = onContainerStarted !== undefined;
    const readySettled = !requiresReadyHandshake;
    let readyResolve!: () => void;
    let readyReject!: (error: unknown) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    if (!requiresReadyHandshake) readyResolve();
    let agentTiming: AgentTimingEvent | undefined;
    let agentTimingReceivedAt: number | undefined;
    let runnerError: string | undefined;
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
              ...(agentTiming.systemPromptSnapshotHash !== undefined
                ? {
                    systemPromptSnapshotHash:
                      agentTiming.systemPromptSnapshotHash,
                  }
                : {}),
              ...(agentTiming.memorySnapshotHash !== undefined
                ? { memorySnapshotHash: agentTiming.memorySnapshotHash }
                : {}),
              ...(agentTiming.snapshotHash !== undefined
                ? { snapshotHash: agentTiming.snapshotHash }
                : {}),
              ...(agentTiming.toolCallKey !== undefined
                ? { toolCallKey: agentTiming.toolCallKey }
                : {}),
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
      if (line === "__AGENT_READY__") {
        if (!readySettled) {
          Promise.resolve(onContainerStarted?.())
            .then(() => {
              if (cleanupActive) return;
              containerStartedReported = true;
              readyResolve();
            })
            .catch((error) => {
              readyReject(error);
            });
        }
        return;
      }
      if (line.startsWith(DISCORD_EVENT_PREFIX)) {
        try {
          const parsed: unknown = JSON.parse(
            line.slice(DISCORD_EVENT_PREFIX.length),
          );
          if (isAgentTimingEvent(parsed)) {
            agentTiming = parsed;
            agentTimingReceivedAt = Date.now();
          } else if (isDiscordEvent(parsed)) {
            if (parsed.type === "error") runnerError = parsed.message;
            onDiscordEvent?.(parsed);
          }
        } catch {
          // ignore malformed or unknown events
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
      for (const line of lines) processStderrLine(line);
    });
    if (!cleanupActive) {
      timeoutHandle = setTimeout(async () => {
        if (stderrTail) {
          processStderrLine(stderrTail);
          stderrTail = "";
        }
        reportExecutionTiming(Date.now(), "timeout");
        cleanupActive = true;
        proc.kill("SIGKILL");
        signal?.removeEventListener("abort", cancelActiveRun);
        try {
          await stopContainer(containerName);
        } catch (cleanupError) {
          runningContainers.delete(containerName);
          signal?.removeEventListener("abort", cancelActiveRun);
          reject(
            new NonRetryableError(
              `タイムアウト後のコンテナ後始末に失敗しました: ${String(cleanupError)}`,
            ),
          );
          return;
        }
        runningContainers.delete(containerName);
        signal?.removeEventListener("abort", cancelActiveRun);
        reject(
          new TransientError(
            `タイムアウト（${formatTimeoutLabel(agentTimeoutMs)}を超過しました）`,
          ),
        );
      }, agentTimeoutMs);
    }

    proc.on("close", (code: number | null) => {
      if (cleanupActive) return;
      if (requiresReadyHandshake) cleanupActive = true;
      signal?.removeEventListener("abort", cancelActiveRun);
      clearTimeout(timeoutHandle);
      runningContainers.delete(containerName);
      if (stderrTail) {
        processStderrLine(stderrTail);
        stderrTail = "";
      }
      reportExecutionTiming(Date.now(), "close", code);
      if (requiresReadyHandshake && !containerStartedReported) {
        if (!readySettled) readyReject(new Error("runner exited before ready"));
        reject(new TransientError("runner exited before ready"));
        return;
      }
      if (code === 0 && (runnerError || agentTiming?.stopReason === "error")) {
        reject(
          new NonRetryableError(
            `agent error: ${runnerError ?? "assistant stopReason=error"}`,
          ),
        );
      } else if (code === 0) resolve(stdout.trim());
      else if (code === 2) reject(new TransientError(plainStderr.trim()));
      else if (code === null)
        reject(new TransientError("コンテナがシグナルで終了しました"));
      else
        reject(
          new NonRetryableError(
            `エージェント実行エラー: ${plainStderr.trim()}`,
          ),
        );
    });

    proc.on("error", (err: Error) => {
      if (cleanupActive) return;
      cleanupActive = true;
      signal?.removeEventListener("abort", cancelActiveRun);
      clearTimeout(timeoutHandle);
      runningContainers.delete(containerName);
      reportExecutionTiming(Date.now(), "spawn-error");
      reject(err);
    });
    readyPromise
      .then(() => {
        if (cleanupActive) return;
        if (signal?.aborted) {
          cancelActiveRun();
          return;
        }
        proc.stdin.write(payload);
        proc.stdin.end();
      })
      .catch((error) => {
        if (cleanupActive) return;
        cleanupActive = true;
        clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", cancelActiveRun);
        runningContainers.delete(containerName);
        proc.kill("SIGKILL");
        void stopContainer(containerName).then(
          () => reject(error),
          (cleanupError) =>
            reject(
              new NonRetryableError(
                `起動後の後始末に失敗しました: ${String(cleanupError)}`,
              ),
            ),
        );
      });
  }).finally(() => {
    internalRequest?.revoke();
  });
}
