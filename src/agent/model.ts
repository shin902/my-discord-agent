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

function resolveThinkingFormat(
  entry: CredentialEntry,
  baseUrl: string,
): NonNullable<Model<"openai-completions">["compat"]>["thinkingFormat"] {
  const format = entry.compat?.thinkingFormat;
  if (format === "qwen") {
    const provider = entry.provider.toLowerCase();
    if (provider.includes("llama-cpp")) return "qwen-chat-template";
    if (provider.includes("ollama") || new URL(baseUrl).port === "11434") {
      return "openrouter";
    }
  }
  // pi-ai は "ollama" を知らないが、Ollama の OpenAI 互換 API は
  // OpenRouter と同じ reasoning: { effort: ... } 形式を使うため "openrouter" で代用する
  if (format === "ollama") return "openrouter";
  return format;
}

function isOllamaThinkingFormat(entry: CredentialEntry, baseUrl: string) {
  return resolveThinkingFormat(entry, baseUrl) === "openrouter";
}

function resolveCompat(
  entry: CredentialEntry,
  baseUrl: string,
): Model<"openai-completions">["compat"] | undefined {
  if (!entry.compat) return undefined;

  return {
    ...entry.compat,
    thinkingFormat: resolveThinkingFormat(entry, baseUrl),
  } as Model<"openai-completions">["compat"];
}

function createCustomModel(
  entry: CredentialEntry,
  baseUrl: string,
  modelId: string,
): Model<Api> {
  const api = entry.api ?? "openai-completions";
  const compat =
    api === "openai-completions" ? resolveCompat(entry, baseUrl) : undefined;
  return {
    id: modelId,
    name: modelId,
    api,
    provider: entry.provider,
    baseUrl,
    reasoning: entry.reasoning ?? Boolean(compat?.thinkingFormat),
    ...(isOllamaThinkingFormat(entry, baseUrl)
      ? {
          thinkingLevelMap: {
            off: "none",
            minimal: "low",
            xhigh: "high",
          },
        }
      : {}),
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: entry.contextWindow ?? 128000,
    maxTokens: entry.maxTokens ?? 4096,
    ...(compat
      ? {
          compat: compat as unknown as Model<Api>["compat"],
        }
      : {}),
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
