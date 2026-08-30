# 仕様: 初回コンテキスト固定とセッション時刻アンカー

GitHub Issue: #117 / 初期実装 PR: #122（マージ済み）

> **ステータス**: 実装済み。本ドキュメントは `src/sandbox/agent-runner.ts` / `src/agent/session.ts` の現行実装を反映する。

## 背景

`runAgentLoop()` はリクエストごとに使い捨ての Agent を生成する。一方、グループsystem prompt・MEMORY.md・現在日時のような情報を毎ターン再生成すると、同じセッションでも過去に LLM が見た prefix が変わり、prefill / KV / prompt cache の再利用を阻害する。

このため、セッション中のコンテキストは可能な限り byte-stable に保つ。

## 基本方針

- グループsystem prompt / MEMORY.md / SELF.md はセッション初回に固定し、2回目以降はファイルを再読込しない。
- セッション開始時刻は **hour単位の固定アンカー**として systemPrompt に含める。
- 現在日時を毎ターン systemPrompt へ再注入しない。
- 過去の user / assistant 履歴へ timestamp を後付けしたり、LLM送信時に再renderしたりしない。
- 正確な「今」が必要な処理は、許可された AgentConfig で `date` ツールを使う。
- 将来、長期間空いたセッション再開時に `Session resumed at ...` のような新規 tail event を追加する案はあるが、初版には含めない。

## グループsystem prompt / MEMORY.md / SELF.md の固定

pi-agent-core 標準の `CustomMessage`（`role: "custom"`）と独自 `convertToLlm` を利用する。`display: false` はTUI表示用で、LLM送信可否とは別概念。

| customType | 対象 | LLM への渡し方 |
|---|---|---|
| `system-prompt-snapshot` | グループsystem prompt（現在の保存元は AGENTS.md） | チャット履歴には乗せない。systemPrompt の組み立てにのみ使う |
| `memory-bootstrap` | MEMORY.md | 最初の1件のみ `role: "user"` に展開 |
| `self-bootstrap` | `/workspace/memory/SELF.md` | 最初の1件のみ `role: "user"` に展開 |
| `skill-invocation` | `./command` で明示実行したスキル本文 | 出現するたび `role: "user"` に展開 |

### グループsystem promptと MEMORY.md / SELF.md の扱いが異なる理由

- **グループsystem promptは system role に残す**: 指示遵守の優先度を維持する。初回に `system-prompt-snapshot` として固定し、以後はその内容を systemPrompt に再利用する。
- **MEMORY.md / SELF.md は user role に変換**: system prompt との二重注入を避けつつ、会話履歴の一部として届ける。

### なぜ生の user メッセージとして保存しないか

session-logs 等は `role == "user"` を実ユーザー発言として扱う。初期コンテキストを生の user メッセージとして JSONL に書くと、日次/週次サマリーへシステム由来の文章が混入する。

保存形式を `custom`、LLM送信形式を `user` に分離することで、履歴の意味を保つ。

## セッション時刻アンカー

### 目的

LLMへ「このセッションがいつ始まったか」という時間軸の基準だけを与えつつ、毎ターン変動する現在時刻でsystem prompt cacheを壊さない。

LLMに見せる形式は次のような hour 単位の固定値とする。これは現在時刻ではないことを明示し、現在日時が必要な場合は `date` ツールを使わせる。

```text
## Fixed session start time

Started: 2026-08-28 07:00 JST (Fri)

This is the fixed session start time, not the current time.
Use the `date` tool when current time matters.
```

### 保存先

時刻アンカーは `session-time-anchor` の CustomMessageとしてsession trajectoryへ1件だけ追加する。`display: false` とし、通常のLLM送信用履歴からは除外して systemPrompt の組み立てにだけ使う。

これにより、時刻機能の導入・再開で過去の user / assistant / tool 履歴本文そのものを変更しない。

### 新規セッション

初回 `runAgentLoop()` で現在時刻を hour bucket に丸め、`session-time-anchor` を`sessions.sqlite`のappend-only entryとして追記する。以後は毎回同じ値を読み、同一の systemPrompt 断片を再生成する。

### 既存セッションの移行

`session-time-anchor` がまだ無い既存セッションでは、保存済みtrajectory entryの **最古 timestamp** を開始時刻として一度だけ保存する。履歴本文への timestamp 追記や再renderは行わない。

同一セッションの初期化競合については、既存のJSONL追記と同じ保証範囲で扱う。

## `date` ツールとの責務分離

固定アンカーは「セッション開始時点」の情報であり、現在時刻ではない。この区別は system prompt 内にも明示する。

現在の月日・曜日・時分秒が必要な場合は `date` ツールを使う。`date` は Bash やネットワークに依存せず、Asia/Tokyo（JST, UTC+09:00）の正確な日時とUTC時刻を返す。

`date` は通常ツールと同じ capability として registry に登録されるため、自動的に全グループへ開放はしない。利用したい group / channel / cron の effective AgentConfig `tools` に `date` を含める。

## systemPrompt の組み立て順

通常は次の順で組み立てる。

1. `system-prompt-snapshot` の内容、またはグループsystem prompt不在時の `DEFAULT_SYSTEM_PROMPT`
2. 固定 `Fixed session start time`
3. `formatSkillsForPrompt()` のスキル一覧（有効な場合）
4. request-scoped `systemPromptAppend`（cron の NO_REPLY 指示など、有効な場合）

MEMORY.md / SELF.md はここへ重複注入せず、context-bootstrap 経由で会話履歴へ入る。

## 空ファイルの扱い（オプトアウト仕様）

ファイル不存在（`null`）と空文字（`""`）を区別する。

- **グループsystem promptが空文字**: `system-prompt-snapshot` を空内容で保存し、DEFAULT_SYSTEM_PROMPT も除外する。結果として systemPrompt は固定session start time（+ skills / request append）のみになる。
- **MEMORY.md / SELF.md が空文字**: 対応する bootstrap を空内容で保存し、「存在するが空」の状態を固定する。

空文字でもスナップショット/bootstrapを保存しないと「内容なし」と「未注入」を区別できず、毎ターン再読込する非対称性が生じるため、この挙動は意図的である。

## ロード時の並べ替え

trajectory内の bootstrap 系（`system-prompt-snapshot` / `memory-bootstrap` / `self-bootstrap`）は `loadMessages()` 後に正規順序で履歴先頭へ並べ替える。旧形式セッションの移行で bootstrap がtrajectory末尾に追記されても、移行ターンと次ターン以降で LLM-visible ordering が変わらないようにするため。

時刻アンカーは systemPrompt にだけ使うため、この並べ替え対象にはならない。

## セッションモード別の考慮事項

- **shared**: チャンネル全体で1セッション。長期間使い回しても開始アンカーは固定される。アンカーは現在時刻ではないため、正確な現在日時は `date` を使う。
- **thread**: スレッドごとにセッション開始アンカーを1件作る。
- **auto-thread**: 新スレッド作成時のセッションに対してアンカーを1件作る。

## キャッシュ不変条件

この仕様で特に守るものは次の通り。

- 一度 LLM に渡した過去の会話本文を、時刻付与のために後から変更しない。
- session time anchor は初回決定後に更新しない。
- MEMORY.md / SELF.md の bootstrap 順序をセッション途中で変えない。
- live current time を system prompt の変動要素にしない。

これにより、時間認識のために prefix/KV cache の安定性を犠牲にしない。
