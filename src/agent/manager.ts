import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExecTimeoutError, Sandbox } from "microsandbox";
import { NonRetryableError } from "../utils/error.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../../");

import { loadCredentialProxy } from "../config/credential-proxy.js";
import {
  loadGroupConfig,
  loadGroupSystemPrompt,
} from "../config/group-config.js";
import { resolveTools } from "../tools/registry.js";

import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER,
  resolveModel,
  validateModel,
} from "./model.js";

export { DEFAULT_MODEL_ID, DEFAULT_PROVIDER, resolveModel, validateModel };

/**
 * 指定セッションのメッセージをmicroVM内のエージェントに送り、返答テキストを返す。
 * モデル・ツールのバリデーションをサンドボックス起動前に行い設定エラーを早期検出する。
 * クレデンシャルはTSI経由でVMに渡さずネットワーク層で差し替える。
 */
export async function sendMessage(
  groupName: string,
  sessionId: string,
  content: string,
): Promise<string> {
  const [groupConfig, systemPrompt] = await Promise.all([
    loadGroupConfig(groupName),
    loadGroupSystemPrompt(groupName),
  ]);

  try {
    resolveModel(
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

  await Promise.all([
    mkdir(path.join(ROOT, "data/sessions"), { recursive: true }),
    mkdir(path.join(ROOT, "groups", groupName), { recursive: true }),
  ]);

  let distExists = false;
  try {
    await stat(path.join(ROOT, "dist"));
    distExists = true;
  } catch {
    distExists = false;
  }

  const creds = await loadCredentialProxy();
  const payload = JSON.stringify({
    groupName,
    sessionId,
    content,
    groupConfig,
    systemPrompt,
  });

  let builder = Sandbox.builder(`agent-${sessionId}-${randomUUID()}`)
    .image("node:22-alpine")
    .workdir("/workspace")
    .cpus(1)
    .memory(512)
    .env("SESSIONS_DIR", "/app/data/sessions")
    .volume("/app/node_modules", (mb) =>
      mb.bind(path.join(ROOT, "node_modules")).readonly(true),
    )
    .volume("/app/config", (mb) =>
      mb.bind(path.join(ROOT, "config")).readonly(true),
    )
    .volume("/workspace", (mb) => mb.bind(path.join(ROOT, "groups", groupName)))
    .volume("/app/data/sessions", (mb) =>
      mb.bind(path.join(ROOT, "data/sessions")),
    );

  if (distExists) {
    builder = builder.volume("/app/dist", (mb) =>
      mb.bind(path.join(ROOT, "dist")).readonly(true),
    );
  } else {
    builder = builder.volume("/app/src", (mb) =>
      mb.bind(path.join(ROOT, "src")).readonly(true),
    );
  }

  for (const entry of creds) {
    const value = process.env[entry.envVar];
    if (!value) continue;
    const placeholder = `msb_${entry.envVar.toLowerCase()}`;
    const host = new URL(entry.baseUrl).hostname;
    builder = builder.secret((sb) =>
      sb
        .env(entry.envVar)
        .value(value)
        .placeholder(placeholder)
        .allowHost(host)
        .injectHeaders(true),
    );
  }

  await using sandbox = await builder.create();

  try {
    const result = distExists
      ? await sandbox.execWith("node", (e) =>
          e
            .args(["/app/dist/sandbox/agent-runner.js", payload])
            .timeout(10 * 60 * 1000),
        )
      : await sandbox.execWith("npx", (e) =>
          e
            .args(["tsx", "/app/src/sandbox/agent-runner.ts", payload])
            .timeout(10 * 60 * 1000),
        );

    if (result.code !== 0) {
      const stderr = result.stderr().trim();
      if (result.code === 2) {
        throw new Error(`一時的エラー: ${stderr}`);
      }
      return `エージェント実行エラー: ${stderr}`;
    }

    return result.stdout().trim();
  } catch (err) {
    if (err instanceof ExecTimeoutError) {
      throw new NonRetryableError("タイムアウト（10分を超過しました）");
    }
    throw err;
  }
}
