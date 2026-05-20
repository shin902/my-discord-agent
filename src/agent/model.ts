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
    // 上記以外（vLLM・SGLang 等の Qwen 互換サーバー）は "qwen" のまま pi-ai に渡す。
    // pi-ai は "qwen" を enable_thinking: boolean として処理する（types.d.ts:265 参照）。
  }
  // 暫定: pi-ai が "ollama" をサポートするまで "openrouter" で代用。
  // Ollama の OpenAI 互換 API は reasoning: { effort } 形式を使うため動作上は等価。
  // model.compat.thinkingFormat が "openrouter" に見えるのはこの変換によるもの。
  if (format === "ollama") return "openrouter";
  return format;
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
  // opencode-go は全モデル（Kimi/DeepSeek 等）で reasoning_content が必須
  const isOpencodeGo =
    entry.provider === "opencode-go" || baseUrl.includes("opencode.ai");
  const resolvedFormat =
    api === "openai-completions"
      ? (resolveThinkingFormat(entry, baseUrl) ?? (isOpencodeGo ? "openai" : undefined))
      : undefined;
  // reasoning: false を明示した場合は thinking を完全に無効化するため compat も除外する
  const compat: Model<"openai-completions">["compat"] | undefined =
    entry.reasoning !== false && (entry.compat != null || isOpencodeGo) && resolvedFormat !== undefined
      ? ({
          // opencode-go デフォルト（entry.compat で上書き可能）
          ...(isOpencodeGo
            ? { requiresReasoningContentOnAssistantMessages: true, supportsReasoningEffort: false }
            : {}),
          ...entry.compat,
          thinkingFormat: resolvedFormat,
        } as Model<"openai-completions">["compat"])
      : undefined;
  const originalFormat = entry.compat?.thinkingFormat;
  // resolveThinkingFormat が "qwen"→"openrouter" に変換した場合は Ollama 系プロバイダを意味する
  const isOllama =
    originalFormat === "ollama" ||
    (originalFormat === "qwen" && resolvedFormat === "openrouter");
  return {
    id: modelId,
    name: modelId,
    api,
    provider: entry.provider,
    baseUrl,
    reasoning: entry.reasoning ?? (isOpencodeGo || Boolean(compat?.thinkingFormat)),
    ...(isOllama
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
    ...(compat ? { compat } : {}),
  } as Model<Api>;
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
