# 仕様: AGENTS.md / MEMORY.md の初回のみ注入

GitHub Issue: #117 / 実装 PR: #122（マージ済み）

> **ステータス**: 実装済み。本ドキュメントは `src/sandbox/agent-runner.ts` の現行実装を反映している。
> 当初案（tool_use + tool_result ペア注入）は採用せず、調査（`docs/research/openclaw-context-injection-analysis.md` の経路 B）が推奨した
> pi-agent-core 標準の `CustomMessage`（`role: "custom"`）方式に着地した。

## 背景

以前の `runAgentLoop()` は毎リクエストで AGENTS.md と MEMORY.md を読み込み、システムプロンプトに結合していた。Agent は毎回使い捨て生成されるため、これらのファイルが更新されるとシステムプロンプト全体が変わり、以下の問題が生じていた。

- プロンプトキャッシュが無効化される（システムプロンプトのプレフィックスが変わるため）
- 毎リクエストでファイル I/O が発生する
- セッション内容を毎回 prefill し直すことになり、レスポンスが遅くなる

## 方針

openclaw の「初回のみ注入」の思想に倣う。ただし openclaw の独自 harness 層（`@openclaw/agent-core`）はプライベートで利用できないため、pi-agent-core が標準提供する `CustomMessage`（`role: "custom"`）＋ 独自 `convertToLlm` で同等の制御を実現する。

AGENTS.md と MEMORY.md はセッション開始時（初回リクエスト）にのみ読み込み、`role: "custom"` のメッセージとしてセッション JSONL に固定化する。2 回目以降のリクエストではファイルを読み込まず、JSONL に保存済みの内容を再利用する。

## 注入形式: pi-agent-core 標準の CustomMessage（`role: "custom"`）

`customType` で 2 種類を使い分ける。いずれも `display: false`（裏方メッセージ。TUI 表示の可否判定用フィールドで、本プロジェクトの LLM 送信可否制御とは別概念）。

| customType | 対象 | LLM への渡し方 |
|---|---|---|
| `system-prompt-snapshot` | グループ system prompt（現在の保存元は AGENTS.md） | **チャット履歴には乗せない**。`convertToLlm` で常に除外し、systemPrompt（system role）の組み立てにのみ使う |
| `memory-bootstrap` | MEMORY.md | **最初の 1 件のみ `role: "user"` に展開**。擬似ユーザーメッセージとして会話履歴経由で渡す |

旧セッションの `agents-snapshot` も読み込み時だけ互換扱いし、新規に保存する customType は `system-prompt-snapshot` とする。

### AGENTS.md と MEMORY.md で扱いが異なる理由

- **AGENTS.md は system role に残す**: 指示遵守の優先度を維持するため、チャット履歴ではなく systemPrompt（system role）に置く。ただし毎ターン再読み込みすると使い捨て Agent ではキャッシュが崩れるため、初回に `system-prompt-snapshot` としてセッションに固定化し、2 回目以降はそのスナップショット内容を systemPrompt に再利用する（ファイル更新の影響を受けない）。
- **MEMORY.md は user role に変換**: AGENTS.md（system）との二重注入を避けつつ、会話履歴の一部として届ける。

### なぜ user メッセージそのものではなく custom 型か

session-logs スキルを使った cron ジョブ（memory-daily / memory-weekly）が `role == "user"` でユーザー発言を抽出している。初期コンテキストを生の user メッセージとして JSONL に書くと、日次/週次サマリーにシステムプロンプト相当の内容が混入する。

`role: "custom"` で JSONL に保存すれば、session-logs の既存クエリ（`select(.role == "user")` 等）の抽出対象にならない。LLM へは `convertToLlm` の中でのみ（memory-bootstrap を）user に展開するため、保存形式（custom）と送信形式（user）を分離できる。

## convertToLlm の実装

`defaultConvertToLlm`（`agent-runner.ts`）で AgentMessage[] → LLM Message[] 変換を制御する。

- `system-prompt-snapshot`: 常に空配列（除外）。systemPrompt 側で扱うため。
- `memory-bootstrap`: 最初の 1 件のみ `{ role: "user", content, timestamp }` に展開。2 件目以降は除外（セッションあたり 1 件しか書き込まれないため実質発動しない安全弁）。
- それ以外（標準 role・他の customType 等）: pi-agent-core 標準の `convertToLlm`（`libraryConvertToLlm`）に委譲する。未知の role を素通しせず、ライブラリの正規処理に任せるため。

## 空ファイルの扱い（オプトアウト仕様）

ファイル不存在（`null`）と空文字（`""`）を区別する。

- **AGENTS.md が空文字**: `system-prompt-snapshot` を空内容で書き込み、systemPrompt 組み立て時に `systemPromptContent ?? DEFAULT_SYSTEM_PROMPT` が `""` のまま `.filter(Boolean)` で除外される。結果として DEFAULT_SYSTEM_PROMPT も含まれず、systemPrompt は skills + 日付のみになる。**「空の AGENTS.md を置く」ことをベースプロンプトの明示的オプトアウト手段として扱う**（ファイル不存在=null の場合のみ DEFAULT を適用）。
- **MEMORY.md が空文字**: `memory-bootstrap` を空内容で書き込む。「ファイルは存在し空である」状態を固定化し、毎ターン再読み込みし続ける非対称性を防ぐ。

いずれも空文字でもスナップショット/bootstrap を書き込むのがポイント。書き込まないと「内容なし」と「未注入」が区別できず、毎ターンファイルを読み直してしまう。

## ロード時の並べ替え

bootstrap 系（`system-prompt-snapshot` / `memory-bootstrap`）は `loadMessages()` 後に常に履歴の先頭へ並べ替える。旧形式セッションの移行では `appendMessage` で JSONL 末尾に追記されるため、並べ替えないと移行ターンと次ターン以降で memory-bootstrap の位置が変わり、LLM への見え方が非対称になりプロンプトキャッシュも効かなくなる。

## 変更対象（実装結果）

### agent-runner.ts（主たる変更）

- `system-prompt-snapshot` / `memory-bootstrap` の `CustomMessage` 型定義（content を string に限定）と型ガード（`isSystemPromptSnapshotMessage` / `isMemoryBootstrapMessage`）
- `loadMessages()` 後に bootstrap メッセージを先頭へ並べ替え
- 既存スナップショット/bootstrap の有無で `needsSystemPromptSnapshot` / `needsMemoryBootstrap` を判定し、必要時のみファイル読み込み
- 新規/未移行セッションで bootstrap メッセージを `appendMessage()` で書き込み、`messages` 先頭に追加
- systemPrompt の組み立てを `[AGENTS.md（or DEFAULT）, skills, date]` に変更（MEMORY.md セクションは除外。MEMORY.md は memory-bootstrap 経由で会話履歴に届く）
- `defaultConvertToLlm` を実装し Agent コンストラクタに渡す

### session.ts

変更なし。既存の `appendMessage()` / `loadMessages()` が `CustomMessage`（`role: "custom"`）をそのまま JSONL に読み書きできる。

### manager.ts / poller.ts / handler.ts / inbox.ts / group-config.ts

変更なし。疎結合は維持された。

## 既存セッションの扱い（フォールバック）

この変更を適用した後、bootstrap メッセージを持たない旧形式セッションについては:

- `messages` に bootstrap がない → `needsAgentsSnapshot` / `needsMemoryBootstrap` が true になる
- そのターンで AGENTS.md / MEMORY.md を読み込み、bootstrap メッセージを書き込んで新方式に移行する（次回以降は再読み込みしない）
- AGENTS.md は移行後も systemPrompt（system role）に含まれるため、挙動の連続性は保たれる

## セッションモード別の考慮事項

- **shared**: チャンネル全体で 1 セッション。長期間使い回されるため、AGENTS.md / MEMORY.md が更新されても既存セッションには反映されない。ただし「初回のみ注入」が方針なのでこれは許容する。
- **thread**: スレッドごとにセッション。スレッド作成時に注入される。
- **auto-thread**: 新スレッド作成時に注入される。

## 確定した設計判断（旧「未解決事項」）

1. **MEMORY.md の 2000 字制限**: `formatMemoryForPrompt`（`MEMORY_CHAR_LIMIT = 2000`）で truncate し、超過時は整理を促す警告を付与する。セッション履歴のトークン消費を抑えるため維持。
2. **スキルの注入**: スキル（`formatSkillsForPrompt`）は初回注入にせず、引き続き毎ターン systemPrompt に組み立てる（変更頻度が低く安定しているため）。日付（`formatDateForPrompt`）も同様に毎ターン組み立てる。
3. **shared セッションのリフレッシュ手段**: 長期間使われる shared セッションで AGENTS.md を更新反映したい場合の手段（セッションリセット等）は別 issue で検討する。
