---
name: runtime-db
description: "runtime.sqlite、queue job、delivery、idempotency、Discord sync cursorの状態確認や障害調査で使う。DBを直接触る前に使う。"
---

# runtime-db

Runtime DBは通常 `data/runtime.sqlite`。`RUNTIME_DB_PATH` があればそちらを使う。

まず付属のread-only CLIを使う。

```bash
.pi/skills/runtime-db/scripts/runtime-db.sh path
.pi/skills/runtime-db/scripts/runtime-db.sh tables
.pi/skills/runtime-db/scripts/runtime-db.sh schema [table]
.pi/skills/runtime-db/scripts/runtime-db.sh jobs [limit]
.pi/skills/runtime-db/scripts/runtime-db.sh job <id>
.pi/skills/runtime-db/scripts/runtime-db.sh deliveries [limit]
.pi/skills/runtime-db/scripts/runtime-db.sh delivery <id>
.pi/skills/runtime-db/scripts/runtime-db.sh idempotency [limit]
.pi/skills/runtime-db/scripts/runtime-db.sh cursors
.pi/skills/runtime-db/scripts/runtime-db.sh query '<SELECT/PRAGMA/WITH/EXPLAIN>'
```

`jobs`はagent実行、`deliveries`は外部配送、`idempotency_keys`は重複抑止を表す。`discord_sync_cursors`はDiscord履歴バックフィルのカーソル。

状態遷移やschemaを調べる場合は `src/queue/repository.ts` と関連テストを読む。直接mutationが必要な場合は、lease/fencing/retry/delivery/idempotencyを確認し、既存のrepository/operator APIを優先する。付属scriptはmutationを提供しない。
