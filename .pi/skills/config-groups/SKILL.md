---
name: config-groups
description: "config/groups.json、Discord channel/group、sessionMode、model、tools、skills、mounts、bot選択などgroup設定を変更・調査するときに使う。"
---

# config-groups

`config/groups.example.json`、`docs/config.md`、session routingなら `docs/spec/channel-modes.md` を先に確認する。必要なら `src/config/groups.ts` とDiscord intake実装で実際のvalidation/routingを確認する。

`groups/{name}/AGENTS.md` はruntime agent prompt。利用可能toolの列挙など、configから導出できる情報をpromptへ重複させない。

channel IDはDiscord全体で一意。設定変更後は起動時cacheや再起動要否も確認する。
