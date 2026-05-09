import { Agent } from '@mariozechner/pi-agent-core';
import { getProviders, getModels } from '@mariozechner/pi-ai';
import type { KnownProvider } from '@mariozechner/pi-ai';
import { loadMessages, appendMessage } from './session.js';
import { loadGroupConfig, loadGroupSystemPrompt } from '../config/group-config.js';

const DEFAULT_PROVIDER = 'opencode-go';
const DEFAULT_MODEL_ID = 'kimi-k2.6';
const DEFAULT_SYSTEM_PROMPT = 'あなたは役立つDiscordアシスタントです。';

export function resolveModel(provider: string, modelId: string) {
  const providers = getProviders();
  if (!providers.includes(provider as KnownProvider)) {
    throw new Error(`不明なプロバイダ: ${provider}`);
  }
  const model = getModels(provider as KnownProvider).find((m) => m.id === modelId);
  if (!model) throw new Error(`不明なモデル: ${modelId} (provider: ${provider})`);
  return model;
}

/**
 * 指定セッションの Agent にメッセージを送り、返答テキストを返す。
 * Agent はリクエストごとに JSONL から作成して使い捨てる。
 * discord/ 層はこの関数だけを呼ぶ。
 */
export async function sendMessage(groupName: string, sessionId: string, content: string): Promise<string> {
  const [messages, groupConfig, systemPrompt] = await Promise.all([
    loadMessages(groupName, sessionId),
    loadGroupConfig(groupName),
    loadGroupSystemPrompt(groupName),
  ]);

  let model;
  try {
    model = resolveModel(
      groupConfig.model?.provider ?? DEFAULT_PROVIDER,
      groupConfig.model?.modelId ?? DEFAULT_MODEL_ID,
    );
  } catch (err) {
    return `設定エラー: ${err instanceof Error ? err.message : '不明なエラー'}`;
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
  agent.subscribe(async (event) => {
    if (event.type === 'message_end') {
      await appendMessage(groupName, sessionId, event.message);
    }
  });

  // ストリーミングレスポンスを連結して返す。Agent は使い捨てなので、完了後は破棄される。unsubscribe は不要。
  let response = '';
  agent.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      response += event.assistantMessageEvent.delta;
    }
  });

  try {
    await agent.prompt(content);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[sendMessage] sessionId=${sessionId} でエラーが発生しました:`, errorMessage);
    // TODO: 一時的エラー（タイムアウト・レートリミット等）の場合はリトライ処理を検討する
    return `エラーが発生しました: ${errorMessage}`;
  }

  return response;
}
