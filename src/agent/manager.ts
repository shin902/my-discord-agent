import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCredentialProxy } from "../config/credential-proxy.js";
import { loadGroupConfig } from "../config/group-config.js";
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
  | { type: "tool_start"; toolName: string; args: unknown }
  | { type: "error"; message: string };

const DISCORD_EVENT_PREFIX = "__DISCORD_EVENT__:";

let storedProxyPort: number | null = null;

export async function initManager(proxyPort: number): Promise<void> {
  storedProxyPort = proxyPort;
  await mkdir(path.join(ROOT, "data/sessions"), { recursive: true });
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

    const { envVars: _ev, msal: _msal, auth: _auth, ...rest } = entry;
    sanitized.push({
      ...rest,
      baseUrl: `http://host.docker.internal:${proxyPort}/${entry.provider}`,
    });
  }
  return JSON.stringify(sanitized);
}

export async function sendMessage(
  groupName: string,
  sessionId: string,
  content: string,
  onDiscordEvent?: (event: DiscordEvent) => void,
): Promise<string> {
  const groupConfig = await loadGroupConfig(groupName);

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

  await mkdir(path.join(ROOT, "groups", groupName), { recursive: true });

  if (storedProxyPort === null) {
    throw new NonRetryableError(
      "credential proxy server が初期化されていません。initCredentialProxyServer() を initManager() より前に呼んでください",
    );
  }
  const proxyPort = storedProxyPort;

  const creds = await loadCredentialProxy();
  const credentialJson = buildSanitizedCredentialJson(creds, proxyPort);

  const payload = JSON.stringify({
    groupName,
    sessionId,
    content,
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
    `${path.join(ROOT, "data/sessions")}:/sessions`,
    "-v",
    `${path.join(ROOT, "groups", groupName)}:/workspace`,
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

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrTail += chunk.toString();
      const lines = stderrTail.split("\n");
      stderrTail = lines.pop() ?? "";
      for (const line of lines) {
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
        if (stderrTail.startsWith(DISCORD_EVENT_PREFIX)) {
          try {
            const event = JSON.parse(
              stderrTail.slice(DISCORD_EVENT_PREFIX.length),
            ) as DiscordEvent;
            onDiscordEvent?.(event);
          } catch {
            // ignore
          }
        } else {
          plainStderr += stderrTail;
        }
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
