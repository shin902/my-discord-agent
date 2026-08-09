# バグ報告: memory-daily-url cron ジョブの無限ループ（完了ジョブの再実行）

- **報告日**: 2026-08-07
- **報告者**: 運用検証（bit ブランチの素ビルド・再起動時の動作確認中）
- **重大度**: 高（cron ジョブが無限ループし、コンテナを無制限に再起動、SQLite ジョブを多重実行）
- **ステータス**: 対症療法済み（dead-letter 化）・根本修正未実施

> 本稿は運用検証の初期報告を、コード・DB・backup・セッションログの突き合わせ結果で
> 事実（実測）と根因分析の推測を分離して訂正したものです。実測と合致しない初期報告の
> 項は §3 にて明示的に注記しています。

---

## 1. 概要

`memory-daily-url`（cron `0 0 * * *` = 毎日 00:00 JST）が、**00:00 発火・00:11 に一度正常完了済み**であるにも関わらず、同日 16:08 のプロセス再起動後に **同一ジョブが再実行**され、LLM エージェントループが終了しない状態に陥った。

無限ループのため実行コンテナ 2 基を殺し、ジョブを `dead_letter`（`manual_kill`）に遷移させて再発火を停止した。

## 2. 事実（実測: DB / ログ / セッションファイル / backup）

| 時刻(JST) | 観測 | 出典（実測） |
|---|---|---|
| 08-07 00:00 | `memory-daily-url` cron 発火。`job msg-1786028400391-v0h2ei` 生成 | `runtime.sqlite` `jobs.created_at=2026-08-06T15:00:00.391Z` |
| 00:05 | プロセス起動→JSONL→SQLite 移行。該当 job を backup 保存（この時点で未完了=`completedAt` なし） | `data/queue/archive/inbox.jsonl.1786028709110.bak` |
| 08-07 00:11 | **ジョブは一度正常完了**（memory ファイル作成） | `groups/url/memory/2026-08-06.md` mtime `08-07 00:11:04` |
| 16:08 | プロセス再起動。**同一 job が `attempts=3`・`started_at=16:45` まで再実行**（無限ループ） | `runtime.sqlite` `jobs`（`fencing_token=3`, `last_error` に値） |
| 16:2x | エージェントループ終了せずコンテナ存続（100 回以上 tool 呼び出し） | `data/sessions/url/cron-memory-daily-url.jsonl` |
| 16:45 | 運用手動で 2 コンテナ kill・ジョブを dead-letter 化 | `dead_letters` 記録 `reason=manual_kill` |

### 根本事実（要）

- `jobs` 行 `msg-1786028400391-v0h2ei` は **`completed_at = NULL` のまま**再実行され続けた。
  決して `succeeded/completed` へ遷移させなかった。`completed_at` は実行完了時に書かれないことがある。
- 当該 job の **`idempotency_key = NULL`**（後述 §3 も参照）。

## 3. 根因分析（実測 + 推測; 初期報告との差分明示）

### 3.1 初期報告の主張と、その検証

初期報告 §3 は *「移行前に実行・完了した job が、`inbox.jsonl` 側にしか完了マークが残らず、移行時に `completedAt` 不明で未完了として import され、再実行された」* としています。

**このタイムラインは実測と合致しません。** 実測では、当該 job は 00:05 の移行時点で「実行中・未完了」であり、移行は `completedAt` 無しを正しく扱った（= queued として)。**00:11 に完了したのは「移行前」ではなく「移行後」の実行**であり、完了が DB の `jobs.completed_at` に反映されなかったことが主因です。初期報告の「main 一因は移行時の完了判定」という前提は、事実上成立しませんでした。

### 3.2 実測による主な主因（コード + DB 突き合わせ）

1. **実行完了時の完了永続化が `jobs` に届かない**（主因）
   cron 実行完了は `commitInboxResult()` 等、inbox 系の行更新で完結している。`jobs` 行の
   `completed_at` への同期は別パスであり、failed 時に書かれないケースがある。
   → 結果、job は `jobs` 上で「未完了」のまま残り、再起動後もポーラの実行対象になる。

2. **該当jobの `idempotency_key = NULL`**
   migration の「完了」は `if (message.idempotencyKey)` 経由でのみ実現される。
   当該 job には key が無いため、`completed_at` があっても
   `completed_without_idempotency_key` として dead_letter 化される等、冪等 idempotency の
   クリーンさを利用した再実行抑止が機能しない。

3. **`recoverExpired()` が leased な `claimed/running` を `retry_wait` に戻す**
   完了マークが無い job は lease 失効後 `recoverExpired` により再実行対象に戻される。
   → 再起動後の re-lease で「完了済み job が再実行される」動線が成立する。

## 4. 影響

- cron が毎日 00:00 に、完了済み作業の再実行（メモリ二重書き込み等）を起こしうる。
- プロセス再起動のたびに過去分が再実行されうる。
- 無限ループ時に LLM の serial ロック（`llama-cpp`）を奪い、他スケジ（chat 等）応答が滞留する。
  実際、今回も同実行完了まで `claimed` のまま待機するジョブがあった。

## 5. 対症措置（実施済み）

- 無限ループのコンテナ 2 基を `docker kill`
- `runtime.sqlite` の該当 job を `status='dead_letter'`,`terminal_reason='manual_kill'` に遷移し、`dead_letters` テーブルに記録
- 以降 claim されないことを確認（4 秒待機、新コンテナー無り）

## 6. 推奨（根本修正; 実測に基づく優先順位）

1. **実行完了の永続化を統一**（最優先）
   実行完了時の `jobs.completed_at` への反映を、`commitInboxResult`/equivalent の完了パスから
   必ず行えるようにし、「inbox 完了 ⇔ jobs completed」をトランザクションに一元化する。
2. **冪等キーを強制**（次優先）
   当該 cron job に `idempotency_key` を必ず付与し、migration の完了判定を
   `idempotencyKey` 必須から解除して、`completedAt` を持つ job を完了として取り込めるようにする。
3. **再発対応**
   再起動時に `claimed`/`running` だが `started_at` が古い job を検知して、
   dead-letter 化 or 警告する（`recoverExpired` の再実行前に冪等チェック）。
4. **メモリ出力存在チェック**（補助）
   `message.completedAt` だけでなく、`groups/<group>/memory/*.md` の実在や出力ファイル有無も
   「実行済み」判定に含めるのは補助として有効。
5. **テスト**
   「実行中に再起動 → 完了済みジョブが再実行されない」ケースを追加。