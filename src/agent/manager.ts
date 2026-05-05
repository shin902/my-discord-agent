import { Agent } from '@mariozechner/pi-agent-core';
import { getModel } from '@mariozechner/pi-ai';
import { loadMessages, appendMessage } from './session.js';

/**
 * 指定セッションの Agent にメッセージを送り、返答テキストを返す。
 * Agent はリクエストごとに JSONL から作成して使い捨てる。
 * discord/ 層はこの関数だけを呼ぶ。
 */
export async function sendMessage(sessionId: string, content: string): Promise<string> {
  // JSONL から過去の会話を復元して Agent を作成する
  const messages = await loadMessages(sessionId);

  const agent = new Agent({
    initialState: {
      systemPrompt: 'あなたは役立つDiscordアシスタントです。',
      model: getModel('opencode-go', 'kimi-k2.6'),
      messages,
    },
  });

  // メッセージ完了のたびに JSONL へ追記する（セッション永続化）
  // user・assistant・toolResult をすべて保存する。toolResult を欠かすと
  // 再読み込み時にコンテキストが壊れてプロンプトキャッシュも効かなくなる。
  agent.subscribe(async (event) => {
    if (event.type === 'message_end') {
      await appendMessage(sessionId, event.message);
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
