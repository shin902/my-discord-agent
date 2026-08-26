---
name: config-providers
description: "provider、API endpoint、credentials、envVars、provider concurrencyを設定・調査するときに使う。config/providers.jsonとconfig/credentials.jsonが対象。"
---

# config-providers

`config/providers.example.json`、`config/credentials.example.json`、`docs/config.md` を確認する。Credential Proxyを扱う場合は `docs/config/credential-proxy.md` と `docs/proxy.md` も読む。

`providers.json` は実行ポリシー、`credentials.json` は接続定義。秘密値そのものは `.env` 等のagentから見えない場所に置き、configやGitへ埋め込まない。

新しいprovider/API互換設定は、既存schemaとpi側のAPI形式を確認してから追加する。
