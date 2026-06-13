# エンティティモデル

> 参考: `docs/clone/nanoclaw/src/types.ts`
> nanoclaw は多対多だが、本プロジェクトは1グループ対多チャンネルのシンプルな1対多

```
AgentGroup（エージェント設定プロファイル）
  id, name, folder
  ← config/config.json groups[]  (モデル・ツール・autoReply・スキル設定)
  ← groups/<folder>/AGENTS.md (グループ固有の指示・メモリ)
  │
  └── [1対多] Channel（Discordチャンネル / DM）
        sessionMode
        │
        └── Session（sessionId = message.channelId → 1履歴）
              ※ スレッドは Discord 上で独自の channelId を持つため自然に分離される
```

## 各エンティティの責務

| エンティティ | 責務 |
|---|---|
| `AgentGroup` | エージェントの能力設定（モデル・ツール・スキル）。複数チャンネルを持つ |
| `Channel` | Discordチャンネル1つ。必ず1つのグループに属する。`sessionMode`（`shared` / `thread` / `auto-thread`）を持つ |
| `Session` | 1会話。sessionId（= message.channelId）で一意。スレッドも独自の channelId を持つため自然に分離される |
