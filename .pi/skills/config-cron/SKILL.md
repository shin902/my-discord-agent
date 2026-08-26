---
name: config-cron
description: "config/cron.json、schedule、deliveryMode、sessionMode、handler、per-job model/tools/skillsなどcron設定を変更・調査するときに使う。RSS固有設定はconfig-rssを使う。"
---

# config-cron

`config/cron.example.json` と `docs/spec/cron.md` を先に確認する。必要なら `src/cron/runner.ts`、`src/cron/enqueue.ts`、対象handlerのvalidationを読む。

`deliveryMode` と `sessionMode` は別の責務。handler jobと宣言的jobを混同せず、job固有のmodel/tools/skills overrideも既存schemaに従う。

RSS collect/dispatchを設定する場合は `config-rss` を使う。
