import { createHash, randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExecTimeoutError, Sandbox } from "microsandbox";
import { NonRetryableError, TransientError } from "../utils/error.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../../");

import { loadCredentialProxy } from "../config/credential-proxy.js";
import { loadGroupConfig } from "../config/group-config.js";
import { resolveTools } from "../tools/registry.js";

import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER,
  resolveModel,
  validateModel,
} from "./model.js";

export { DEFAULT_MODEL_ID, DEFAULT_PROVIDER, resolveModel, validateModel };

let _distExists = false;

/**
 * エージェントマネージャーの初期化。起動時に一度だけ呼ぶこと。
 * data/sessions の作成と dist ディレクトリの存在チェックを行い結果をキャッシュする。
 */
export async function initManager(): Promise<void> {
  await mkdir(path.join(ROOT, "data/sessions"), { recursive: true });
  try {
    await stat(path.join(ROOT, "dist"));
    _distExists = true;
  } catch {
    _distExists = false;
  }
}

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
  const groupConfig = await loadGroupConfig(groupName);

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

  await mkdir(path.join(ROOT, "groups", groupName), { recursive: true });

  const creds = await loadCredentialProxy();
  const payload = JSON.stringify({
    groupName,
    sessionId,
    content,
    groupConfig,
  });

  // Unixドメインソケットのパス長制限（SUN_LEN）対策: 短い一意名を生成
  const sessionHash = createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, 8);
  const randSuffix = randomUUID().slice(0, 8);
  let builder = Sandbox.builder(`a-${sessionHash}-${randSuffix}`)
    .image("node:22-slim")
    .workdir("/workspace")
    .cpus(1)
    .memory(512)
    .env("SESSIONS_DIR", "/app/data/sessions")
    .replace()
    .volume("/app", (mb) => mb.bind(ROOT))
    .volume("/workspace", (mb) => mb.bind(path.join(ROOT, "groups", groupName)));

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

  const CREATE_TIMEOUT = 180_000;
  const sandboxPromise = builder.create();
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error("VM起動がタイムアウトしました")),
      CREATE_TIMEOUT,
    ),
  );

  let sandbox: Sandbox;
  try {
    sandbox = await Promise.race([sandboxPromise, timeoutPromise]);
  } catch (err) {
    // タイムアウト時に生成途中のサンドボックスがリークしないようクリーンアップ
    sandboxPromise
      .then((s) =>
        s
          .stop()
          .catch(() => {})
          .then(() => s.removePersisted().catch(() => {})),
      )
      .catch(() => {});
    throw err;
  }
  await using _sandbox = sandbox;

  try {
    const result = _distExists
      ? await sandbox.execWith("node", (e) =>
          e
            .args(["/app/dist/sandbox/agent-runner.js"])
            .stdinBytes(Buffer.from(payload))
            .timeout(10 * 60 * 1000),
        )
      : await sandbox.execWith("npx", (e) =>
          e
            .args(["tsx", "/app/src/sandbox/agent-runner.ts"])
            .stdinBytes(Buffer.from(payload))
            .timeout(10 * 60 * 1000),
        );

    if (result.code !== 0) {
      const stderr = result.stderr().trim();
      if (result.code === 2) {
        throw new TransientError(stderr);
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
