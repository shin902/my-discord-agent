import { Agent } from "@mariozechner/pi-agent-core";
import {
  getModels,
  getProviders,
  type KnownProvider,
  type TextContent,
} from "@mariozechner/pi-ai";
import {
  loadGroupConfig,
  loadGroupSystemPrompt,
} from "../config/group-config.js";
import { appendMessage, loadMessages } from "./session.js";

export const DEFAULT_PROVIDER = "opencode-go";
export const DEFAULT_MODEL_ID = "kimi-k2.6";
const DEFAULT_SYSTEM_PROMPT = "あなたは役立つDiscordアシスタントです。";

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
 * 指定セッションの Agent にメッセージを送り、返答テキストを返す。
 * Agent はリクエストごとに JSONL から作成して使い捨てる。
 * discord/ 層はこの関数だけを呼ぶ。
 */
export async function sendMessage(
  groupName: string,
  sessionId: string,
  content: string,
): Promise<string> {
  const [messages, groupConfig, systemPrompt] = await Promise.all([
    loadMessages(groupName, sessionId),
    loadGroupConfig(groupName),
    loadGroupSystemPrompt(groupName),
  ]);

  let model: ReturnType<typeof resolveModel>;
  try {
    model = resolveModel(
      groupConfig.model?.provider ?? DEFAULT_PROVIDER,
      groupConfig.model?.modelId ?? DEFAULT_MODEL_ID,
    );
  } catch (err) {
    return `設定エラー: ${err instanceof Error ? err.message : "不明なエラー"}`;
  }

  const agent = new Agent({
    initialState: {
      systemPrompt: systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      model,
      messages,
    },
  });

  // メッセージ完了のたびに JSONL へ追記する（セッション永続化）
  // user・assistant・toolResult をすべて保存する。toolResult を欠かすと
  // 再読み込み時にコンテキストが壊れてプロンプトキャッシュも効かなくなる。
  let response = "";
  agent.subscribe(async (event) => {
    if (event.type === "message_end") {
      await appendMessage(groupName, sessionId, event.message);
      // メッセージの生成
      if ("role" in event.message && event.message.role === "assistant") {
        response = event.message.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("");
      }
    }
  });

  await agent.prompt(content);
  return response;
}
