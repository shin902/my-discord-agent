import { z } from "zod";
import { loadRawCredentials } from "./config.js";

export const MsalConfigSchema = z.object({
  tenantId: z.string(),
  clientId: z.string(),
  scopes: z.array(z.string()),
});

export type MsalConfig = z.infer<typeof MsalConfigSchema>;

export const GoogleOAuthConfigSchema = z.object({
  clientId: z.string(),
  // クライアントシークレットそのものは config.json に書かず、
  // ホスト側 process.env からこの名前で読み込む（graph の msal.clientId とは異なり
  // Google の OAuth Device Flow は client_secret を必須とするため）
  clientSecretEnvVar: z.string(),
  scopes: z.array(z.string()),
});

export type GoogleOAuthConfig = z.infer<typeof GoogleOAuthConfigSchema>;

// Reddit は OAuth (client_credentials) の新規アプリ申請を事実上ブロックしているため、
// ログイン済みブラウザの永続プロファイルから定期的に抽出したクッキーを使う
// (docs/reddit-cookie-setup.md 参照)。cookieFile は reddit-cookie-refresh ジョブが書き込む。
export const RedditCookieConfigSchema = z.object({
  cookieFile: z.string().default("data/reddit-cookies.json"),
  maxAgeDays: z.number().int().min(1).default(7),
});

export type RedditCookieConfig = z.infer<typeof RedditCookieConfigSchema>;

// プロバイダー単位の設定のうち、modelId ごとに上書き可能なもの
// （同一サーバーで複数モデルを切り替える場合に使う）
const ModelOverrideSchema = z.object({
  // モデルが受け付ける入力モダリティ。省略時は ["text"]
  input: z.array(z.enum(["text", "image"])).optional(),
});

export const CredentialEntrySchema = z.object({
  provider: z.string(),
  // pi-ai の KnownProvider 名と衝突する場合でも credential-proxy 経由の
  // カスタムプロバイダー解決を強制する（resolveModel 参照）
  forceCustom: z.boolean().optional(),
  envVars: z.array(z.string()).optional(),
  auth: z
    .object({
      type: z.enum(["bearer", "query-token"]),
      queryParam: z.string().optional(),
    })
    .optional(),
  msal: MsalConfigSchema.optional(),
  google: GoogleOAuthConfigSchema.optional(),
  redditCookie: RedditCookieConfigSchema.optional(),
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
      // pi-ai が解釈する具体 wire format を直接指定する（自動補正は行わない）。
      thinkingFormat: z
        .enum(
          ["openai", "openrouter", "deepseek", "zai", "qwen-chat-template"],
          {
            error: (issue) =>
              issue.code === "invalid_value"
                ? 'thinkingFormat は pi-ai が解釈する具体値を直接指定してください（自動補正は廃止）。移行先の例: "qwen"(llama.cpp向け)→"qwen-chat-template" / "qwen"(Ollama向け)・"ollama"→"openrouter"+thinkingLevelMap'
                : undefined,
          },
        )
        .optional(),
      // thinkingLevel をサーバー固有の effort 値にマッピングする。
      // Ollama の OpenAI 互換 API（reasoning.effort）など、
      // pi-ai のデフォルトマップと異なる値体系を使うサーバーで指定する。
      thinkingLevelMap: z
        .object({
          off: z.string(),
          minimal: z.string().optional(),
          low: z.string().optional(),
          medium: z.string().optional(),
          high: z.string().optional(),
          xhigh: z.string().optional(),
        })
        .optional(),
      // model.ts の compat スプレッド経由で pi-ai に渡り、tool_use を含む
      // assistant メッセージへの reasoning_content 補完を有効化する。
      // DeepSeek 系プロバイダーは pi-ai が自動検出するが、カスタムプロバイダーで
      // Kimi 互換 API を使う場合などに明示的に設定する。
      requiresReasoningContentOnAssistantMessages: z.boolean().optional(),
    })
    .optional(),
  // modelId ごとの上書き設定。同一サーバー（同一 baseUrl）で複数モデルを
  // 切り替える場合に、input をモデル単位で指定する
  models: z.record(z.string(), ModelOverrideSchema).optional(),
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
  const raw = await loadRawCredentials();
  cache = z.array(CredentialEntrySchema).parse(raw);
  return cache;
}
