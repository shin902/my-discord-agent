# 実装優先順位

1. **`config/groups.json` の読み込み**（Zod バリデーション）
   - 既存: なし → 新規作成

2. **`session.ts` のパス変更**（`data/sessions/<sessionId>.jsonl` → `data/sessions/<groupName>/<sessionId>.jsonl`）
   - `src/agent/session.ts` の `sessionPath()` に `groupName` 引数を追加
   - `src/agent/manager.ts` の `sendMessage()` にも `groupName` を渡す必要がある

3. **handler のルーティング**（channelId → group + channel → engageMode 判定）

4. **`shared` + `mention` モードの正式対応**（現行コードのリファクタ）

5. **`thread` モードの実装**（ユーザー作成スレッド、`ThreadCreated` フィルタ含む）

6. **`auto-thread` モードの実装**（全メッセージでスレッド自動作成、URL検出によるスレッド名生成）

7. **プロキシサーバーの実装**

8. **Dockerサンドボックスの実装**（将来）
