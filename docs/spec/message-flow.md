# メッセージ処理フロー

> 参考: `docs/clone/VRC-AI-Bot/implementation/src/runtime/message/message-intake-service.ts`
> 参考: `docs/clone/nanoclaw/src/router.ts`

```
Discord メッセージ受信
  → channelId（または parentId）で config/groups.json を検索
  → 対応する channel の engageMode 判定 → 無視 or 処理続行
  → sessionId = message.channelId（モード・スレッド問わず共通、既存実装のまま）
  → Inbox キューに積む（groupId, sessionId を含める）
  → Poller が取り出す
  → groups/<folder>/group.json のグループ設定でエージェントを構築
  → sessions/<groupName>/<sessionId>.jsonl で履歴を読み込み
  → 応答をDiscordに送信
```
