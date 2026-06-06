import { z } from "zod";
import { loadRawConfig } from "./config.js";

export const MsalConfigSchema = z.object({
  tenantId: z.string(),
  clientId: z.string(),
  scopes: z.array(z.string()),
});

export type MsalConfig = z.infer<typeof MsalConfigSchema>;

export const CredentialEntrySchema = z.object({
  provider: z.string(),
  envVars: z.array(z.string()).optional(),
  auth: z
    .object({
      type: z.enum(["bearer", "query-token"]),
      queryParam: z.string().optional(),
    })
    .optional(),
  msal: MsalConfigSchema.optional(),
  baseUrl: z.string().url(),
  api: z
    .enum([
      "openai-completions",
      "mistral-conversations",
      "openai-responses",
      "azure-openai-responses",
      "openai-codex-responses",
      "anthropic-messages",
      "bedrock-converse-stream",
      "google-generative-ai",
      "google-vertex",
    ])
    .optional(),
  reasoning: z.boolean().optional(),
  contextWindow: z.number().int().min(1).optional(),
  maxTokens: z.number().int().min(1).optional(),
  compat: z
    .object({
      thinkingFormat: z
        .enum([
          "openai",
          "openrouter",
          "deepseek",
          "zai",
          "qwen",
          "qwen-chat-template",
          "ollama",
        ])
        .optional(),
      // model.ts の compat スプレッド経由で pi-ai に渡り、tool_use を含む
      // assistant メッセージへの reasoning_content 補完を有効化する。
      // DeepSeek 系プロバイダーは pi-ai が自動検出するが、カスタムプロバイダーで
      // Kimi 互換 API を使う場合などに明示的に設定する。
      requiresReasoningContentOnAssistantMessages: z.boolean().optional(),
    })
    .optional(),
});

export type CredentialEntry = z.infer<typeof CredentialEntrySchema>;

let cache: CredentialEntry[] | null = null;

export async function loadCredentialProxy(): Promise<CredentialEntry[]> {
  if (cache) return cache;
  // sandbox コンテナへの受け渡し: manager.ts が CREDENTIAL_PROXY_JSON に直列化して渡す
  const inlineJson = process.env.CREDENTIAL_PROXY_JSON;
  if (inlineJson) {
    cache = z.array(CredentialEntrySchema).parse(JSON.parse(inlineJson));
    return cache;
  }
  const raw = await loadRawConfig();
  if (raw.credentials === undefined) {
    throw new Error(
      "config/config.json に credentials キーがありません（credentials は必須項目です）",
    );
  }
  cache = z.array(CredentialEntrySchema).parse(raw.credentials);
  return cache;
}
