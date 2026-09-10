import {
  type Api,
  type BuiltinProvider,
  getModels,
  getProviders,
  type Model,
} from "@earendil-works/pi-ai/compat";
import {
  type CredentialEntry,
  loadCredentialProxy,
} from "../config/credential-proxy.js";
import { isLlmCredential } from "../config/llm-credentials.js";

export function resolveBaseUrl(baseUrl: string): string | null {
  const resolved = baseUrl.replace(/\{([A-Za-z0-9_]+)\}/g, (_, envVar) => {
    return process.env[envVar] ?? `{${envVar}}`;
  });
  if (/\{[A-Za-z0-9_]+\}/.test(resolved)) return null;
  return resolved;
}

function createCustomModel(
  entry: CredentialEntry & { api?: "openai-completions" },
  baseUrl: string,
  modelId: string,
): Model<"openai-completions">;
function createCustomModel(
  entry: CredentialEntry,
  baseUrl: string,
  modelId: string,
): Model<Api>;
function createCustomModel(
  entry: CredentialEntry,
  baseUrl: string,
  modelId: string,
): Model<Api> {
  const api = entry.api ?? "openai-completions";
  // compat は pi-ai の OpenAI 互換ストリームレイヤー専用のフィールドなので、
  // api が openai-completions 以外の場合は付与しない
  const thinkingFormat =
    api === "openai-completions" ? entry.compat?.thinkingFormat : undefined;
  // thinkingLevelMap は pi-ai の Model 型ではトップレベルのフィールドなので、
  // entry.compat からは除外して compat に渡す
  const { thinkingLevelMap, ...entryCompatRest } =
    api === "openai-completions" ? (entry.compat ?? {}) : {};
  // reasoning: false を明示した場合は thinking を完全に無効化するため compat も除外する
  const compat: Model<"openai-completions">["compat"] | undefined =
    entry.reasoning !== false && entry.compat && thinkingFormat !== undefined
      ? ({
          ...entryCompatRest,
          thinkingFormat,
        } as Model<"openai-completions">["compat"])
      : undefined;
  return {
    id: modelId,
    name: modelId,
    api,
    provider: entry.provider,
    baseUrl,
    reasoning: entry.reasoning ?? Boolean(compat?.thinkingFormat),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: entry.models?.[modelId]?.input ?? ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: entry.contextWindow ?? 128000,
    maxTokens: entry.maxTokens ?? 4096,
    ...(compat ? { compat } : {}),
  } as Model<Api>;
}

export async function resolveModel(provider: string, modelId: string) {
  const providers = getProviders();
  const builtinProvider = provider as BuiltinProvider;
  const creds = await loadCredentialProxy();
  const entry = creds.find((e) => e.provider === provider);
  if (entry && !isLlmCredential(entry)) {
    throw new Error(
      `${provider}: credential entry is not an LLM route; custom models require api or forceCustom`,
    );
  }

  // forceCustom: pi-ai の KnownProvider 名と衝突していても
  // credential-proxy 経由のカスタムプロバイダー解決を強制する
  if (entry?.forceCustom || !providers.includes(builtinProvider)) {
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
  const model = getModels(builtinProvider).find((m) => m.id === modelId);
  if (!model)
    throw new Error(`不明なモデル: ${modelId} (provider: ${provider})`);
  // Preserve built-in model metadata, but never its direct upstream endpoint
  // in the sandbox. Custom models already use the sanitized entry above.
  if (process.env.CREDENTIAL_PROXY_JSON) {
    if (!entry) {
      throw new Error(`${provider}: sandbox requires a Credential Proxy entry`);
    }
  }
  if (!entry) return model;
  const baseUrl = resolveBaseUrl(entry.baseUrl);
  if (!baseUrl)
    throw new Error(`${provider}: baseUrl に未解決のプレースホルダがあります`);
  // Route and wire API may change; Pi owns all built-in identity and metadata.
  return { ...model, baseUrl, api: entry.api ?? model.api };
}

// 起動時バリデーション専用。無効な設定はスローして即クラッシュさせる
export async function validateModel(
  provider: string,
  modelId: string,
): Promise<void> {
  await resolveModel(provider, modelId);
}
