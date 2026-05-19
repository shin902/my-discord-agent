import {
  type Api,
  getModels,
  getProviders,
  type KnownProvider,
  type Model,
} from "@earendil-works/pi-ai";
import {
  type CredentialEntry,
  loadCredentialProxy,
} from "../config/credential-proxy.js";

export const DEFAULT_PROVIDER = "opencode-go";
export const DEFAULT_MODEL_ID = "kimi-k2.6";

export function resolveBaseUrl(baseUrl: string): string | null {
  const resolved = baseUrl.replace(/\{([A-Za-z0-9_]+)\}/g, (_, envVar) => {
    return process.env[envVar] ?? `{${envVar}}`;
  });
  if (/\{[A-Za-z0-9_]+\}/.test(resolved)) return null;
  return resolved;
}

function createCustomModel(
  entry: CredentialEntry,
  baseUrl: string,
  modelId: string,
): Model<Api> {
  const api = entry.api ?? "openai-completions";
  return {
    id: modelId,
    name: modelId,
    api,
    provider: entry.provider,
    baseUrl,
    reasoning: entry.reasoning ?? false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: entry.contextWindow ?? 128000,
    maxTokens: entry.maxTokens ?? 4096,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(entry.compat ? { compat: entry.compat as any } : {}),
  };
}

export async function resolveModel(provider: string, modelId: string) {
  const providers = getProviders();
  if (!providers.includes(provider as KnownProvider)) {
    const creds = await loadCredentialProxy();
    const entry = creds.find((e) => e.provider === provider);
    if (!entry) {
      throw new Error(`不明なプロバイダ: ${provider}`);
    }
    const resolvedBaseUrl = resolveBaseUrl(entry.baseUrl);
    if (!resolvedBaseUrl) {
      throw new Error(
        `${provider}: baseUrl に未解決のプレースホルダがあります（${entry.baseUrl}）`,
      );
    }
    return createCustomModel(entry, resolvedBaseUrl, modelId);
  }
  const model = getModels(provider as KnownProvider).find(
    (m) => m.id === modelId,
  );
  if (!model)
    throw new Error(`不明なモデル: ${modelId} (provider: ${provider})`);
  return model;
}

// 起動時バリデーション専用。無効な設定はスローして即クラッシュさせる
export async function validateModel(
  provider: string,
  modelId: string,
): Promise<void> {
  await resolveModel(provider, modelId);
}
