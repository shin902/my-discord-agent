---
name: config-core
description: "config/config.json、defaultModel、Discord bot定義、proxy/agent timeoutなど全体設定を変更・調査するときに使う。"
---

# config-core

`config/config.json` の変更前に `config/config.example.json` と `docs/config.md` の該当節を確認する。schemaやdefaultを推測せず、必要なら `src/config/` の実装も確認する。

主な責務は全体default、Discord bot定義、proxy/agent runtime設定。provider接続は `config-providers`、group/channelは `config-groups`、cronは `config-cron` を使う。

実設定はgitignore対象。秘密値をGitへ追加しない。
