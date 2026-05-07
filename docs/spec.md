# エージェント設計仕様

> 参考クローン:
> - `docs/clone/VRC-AI-Bot/` — チャンネルモード・メッセージルーティング
> - `docs/clone/nanoclaw/` — グループ実装・Dockerサンドボックス・プロキシ（OneCLI）

## ドキュメント一覧

| ファイル | 内容 |
|---|---|
| [entity-model.md](spec/entity-model.md) | エンティティモデルと各責務 |
| [storage.md](spec/storage.md) | ストレージ設計（JSON/JSONL の使い分け、`config/groups.json` の形式） |
| [group-fs.md](spec/group-fs.md) | グループのファイルシステム構造（`container.json` など） |
| [channel-modes.md](spec/channel-modes.md) | `engageMode` / `sessionMode` の定義と組み合わせ |
| [message-flow.md](spec/message-flow.md) | メッセージ受信から応答までのフロー |
| [proxy.md](spec/proxy.md) | プロキシサーバー（クレデンシャル安全挿入） |
| [sandbox.md](spec/sandbox.md) | Dockerサンドボックス（将来） |
| [implementation-order.md](spec/implementation-order.md) | 実装優先順位 |
