---
name: config-rss
description: "RSS/Atom feedの収集・配信、rss-collect、rss-dispatch、feed選択、既読状態やRSS cron設定を追加・変更・調査するときに使う。"
---

# config-rss

RSSはbuilt-in pipelineを使う。`config/cron.example.json` の `rss-collect` / `rss-dispatch`、`src/cron/jobs/rss-collect.ts`、`src/cron/jobs/rss-dispatch.ts`、`src/rss/store.ts` を確認する。

基本構成は、collectがfeedをRSS DBへ取り込み、dispatchが未読記事をclaimしてruntime queueへ投入し、job完了後に既読へ収束させる流れ。

feed URL、bootstrap、dispatch対象feed、件数、summary長などは各handlerのschemaに従う。古いFeedCord/Webhook経路を標準構成として使わない。
