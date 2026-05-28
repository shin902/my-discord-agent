import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH =
  process.env.CREDENTIAL_PROXY_PATH ??
  path.join(__dirname, "../../config/credential-proxy.json");

export const CredentialEntrySchema = z.object({
  provider: z.string(),
  envVars: z.array(z.string()).optional(),
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
  const inlineJson = process.env.CREDENTIAL_PROXY_JSON;
  if (inlineJson) {
    cache = z.array(CredentialEntrySchema).parse(JSON.parse(inlineJson));
    return cache;
  }
  let raw: string;
  try {
    raw = await readFile(CONFIG_PATH, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      cache = [];
      return cache;
    }
    throw err;
  }
  cache = z.array(CredentialEntrySchema).parse(JSON.parse(raw));
  return cache;
}
