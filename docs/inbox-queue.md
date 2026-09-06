# 永続キューとDiscord配送

この文書は現行のキュー処理の入口です。正本はホスト所有の `data/runtime.sqlite` であり、JSONLファイルやメモリ上のin-flight集合ではありません。保存先・backup・旧JSONL移行は [ストレージ設計](storage.md) を参照してください。

## 処理の流れ

```text
Discord / cron
  → QueueRepository.enqueue
  → runtime.sqlite: jobs
  → poller: claim → sandboxでAgent実行
  → 実行結果とdeliveriesを同一transactionで保存
  → delivery worker → Discord
```

- [QueueRepository](../src/queue/repository.ts) がenqueue、冪等性、claim、lease、fencing、結果保存、配送状態を管理します。
- [poller](../src/queue/poller.ts) はdurable claimを取得し、[manager](../src/agent/manager.ts) を通じて使い捨てのsandbox containerを起動します。
- [delivery worker](../src/queue/delivery.ts) は保存済みの配送内容を送信します。配送失敗を理由に完了済みAgentを再実行しません。
- 会話履歴はgroupごとの `sessions.sqlite` に保存し、runtime DBとは分離します。

## 状態と順序

`jobs.status` の永続状態は `queued`、`retry_wait`、`claimed`、`running`、`completed`、`dead_letter` です。

claimはtransaction内でworker・lease期限・増分fencing tokenを記録します。コンテナ開始時にrunningへ進み、heartbeatでleaseを更新します。実行中の更新はstatusとfencing tokenを検証し、古いworkerによる更新を拒否します。lease切れは回収・再claimの対象です。

同じ `session_id` の未完了先行jobがある場合は後続をclaimしません。Bot Task Sessionの同期実行も同じDBのadmission ledgerを使います。provider単位の実行制限はこれとは別で、[provider concurrency](spec/provider-concurrency.md) を参照してください。全チャンネルを単一のPromiseチェーンで直列化する設計ではありません。

実行成功時は結果と必要なdelivery chunkを同一transactionで確定します。空応答・配送抑制ではdeliveryを作らず完了できます。再試行可能な実行失敗は `retry_wait`、上限超過などは `dead_letter` へ進みます。完了済みjobは即座に削除するのではなく、retentionの対象になります。

`deliveries.status` は `pending`、`retry_wait`、`sending`、`sent`、`failed`、`ambiguous` です。jobの `completed` はDiscord配送済みを意味しません。送信成否が不明な場合は `ambiguous` を区別し、Discord側を含むexactly-once配送は保証しません。

SQL上の `jobs.status` が状態の正本です。旧 `claimed` 整数列は互換用の複製列であり、TypeScriptの `executionState` は派生表示です。DBを調査する際にこれらを独立した状態機械として扱わないでください。

## 起動・復旧

[起動処理](../src/index.ts) は、管理対象・孤立runnerの停止をstrictに確認してからsession migration、group promptの初期読み込み、設定検証を行います。その後にqueueを初期化し、前プロセスの未完了Bot admission・期限切れ実行の回収と旧queue JSONL移行を行います。

cron設定を読み、RSS reconciliationとruntime health checkを実行してからpoller・delivery worker・cronを開始し、Discordへloginします。Discord ready時の履歴backfillは全Botを通じて一度だけ開始します。詳細は [起動時Discord履歴バックフィル](config.md#起動時discord履歴バックフィル) を参照してください。runnerの停止確認に失敗した場合、queue回収へは進みません。

調査は [runtime-dbスキル](../.pi/skills/runtime-db/SKILL.md) のread-only手順を使います。lease、fencing、delivery、idempotencyの関係を無視した手動の `UPDATE` / `DELETE` は行わないでください。

## 歴史的資料

[JSONLからの移行計画](plan/inbox-queue-reliability.md) は設計時点の記録です。旧 `src/queue/inbox.ts` の `withFileLock`、`peekAllUnclaimedInbox`、`removeInboxById` は現行APIではありません。
