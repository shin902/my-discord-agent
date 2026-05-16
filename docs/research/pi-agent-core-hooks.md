pi-agent-core におけるフック（コールバック・介入ポイント）は以下の通りです：
1. convertToLlm
- タイミング: 各 LLM 呼び出しの直前
- 用途: AgentMessage[] を LLM が理解できる Message[] に変換・フィルタリング
- 必須: カスタムメッセージ型を使う場合は必須
2. transformContext
- タイミング: convertToLlm の直前
- 用途: 古いメッセージの切り詰め、外部コンテキストの注入、圧縮処理など
3. beforeToolCall
- タイミング: ツール呼び出しの引数検証後、tool_execution_start イベント発行後
- 用途: ツール実行前の介入・ブロック
- 戻り値: { block: true, reason: "..." } で実行をブロック可能
4. afterToolCall
- タイミング: ツール実行完了後、tool_execution_end イベントと最終的な tool result メッセージイベント発行の前
- 用途: ツール結果の後処理、エラーハンドリング、早期終了の指示
- 戻り値: 
  - { terminate: true } → 自動フォローアップ LLM 呼び出しをスキップ
  - { details: {...} } → 結果の details を上書き・追加
5. streamFn
- タイミング: LLM ストリーミング時
- 用途: プロキシバックエンド経由でストリームする場合のカスタム実装（streamProxy と併用）
6. getApiKey
- タイミング: プロバイダーが API キーを必要とする際
- 用途: 期限付き OAuth トークンなど、動的な API キーの解決
7. subscribe（イベントリスナー）
- タイミング: エージェントの全イベント発行時
- 用途: UI 更新、ログ記録、状態の永続化など
- 特徴: 登録順に await され、agent_end の awaited サブスクライバーも完了待ちの対象になる
8. shouldStopAfterTurn（低レベル API）
- タイミング: turn_end 発行後、次の LLM 呼び出し前
- 用途: 特定の条件でエージェントループを安全に停止（コンテキスト圧縮が必要かの判定など）
- 対象: agentLoop() / agentLoopContinue() のオプション
---
補足：フックではないが類似の制御機構
- steer() / followUp(): 実行中・停止後にメッセージを注入（キューイング機構）
- abort(): 現在の処理を強制キャンセル