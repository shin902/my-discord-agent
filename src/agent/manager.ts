import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "microsandbox";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../../");
import {
  getModels,
  getProviders,
  type KnownProvider,
} from "@earendil-works/pi-ai";
import { loadCredentialProxy } from "../config/credential-proxy.js";
import { loadGroupConfig } from "../config/group-config.js";
import { resolveTools } from "../tools/registry.js";

export const DEFAULT_PROVIDER = "opencode-go";
export const DEFAULT_MODEL_ID = "kimi-k2.6";

export function resolveModel(provider: string, modelId: string) {
  const providers = getProviders();
  if (!providers.includes(provider as KnownProvider)) {
    throw new Error(`不明なプロバイダ: ${provider}`);
  }
  const model = getModels(provider as KnownProvider).find(
    (m) => m.id === modelId,
  );
  if (!model)
    throw new Error(`不明なモデル: ${modelId} (provider: ${provider})`);
  return model;
}

// 起動時バリデーション専用。無効な設定はスローして即クラッシュさせる
export function validateModel(provider: string, modelId: string): void {
  resolveModel(provider, modelId);
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

  await mkdir(path.join(ROOT, "data/sessions"), { recursive: true });

  const creds = await loadCredentialProxy();
  const payload = JSON.stringify({ groupName, sessionId, content });

  let builder = Sandbox.builder(`agent-${sessionId}-${Date.now()}`)
    .image("node:22-alpine")
    .workdir("/app")
    .cpus(1)
    .memory(512)
    .volume("/app/dist", (mb) => mb.bind(path.join(ROOT, "dist")).readonly())
    .volume(
      "/app/node_modules",
      (mb) => mb.bind(path.join(ROOT, "node_modules")).readonly(),
    )
    .volume("/app/config", (mb) => mb.bind(path.join(ROOT, "config")).readonly())
    .volume("/app/groups", (mb) => mb.bind(path.join(ROOT, "groups")).readonly())
    .volume("/app/data/sessions", (mb) =>
      mb.bind(path.join(ROOT, "data/sessions")),
    );

  for (const entry of creds) {
    const value = process.env[entry.envVar];
    if (!value) continue;
    const placeholder = `msb_${entry.envVar.toLowerCase()}`;
    const host = new URL(entry.baseUrl).hostname;
    const headerValue = entry.injectFormat.replace("{value}", placeholder);
    builder = builder
      .secret((sb) =>
        sb
          .value(value)
          .placeholder(placeholder)
          .allowHost(host)
          .injectHeaders({ [entry.injectHeader]: headerValue }),
      )
      .env(entry.envVar, placeholder);
  }

  await using sandbox = await builder.create();

  const result = await sandbox.exec("node", [
    "/app/dist/sandbox/agent-runner.js",
    payload,
  ]);

  if (result.code !== 0) {
    return `エージェント実行エラー: ${result.stderr().trim()}`;
  }

  return result.stdout().trim();
}
