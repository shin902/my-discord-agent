---
name: update-docs
description: "実装変更でREADME、docs、example config、運用手順が古くならないか確認し、必要な文書だけ更新するときに使う。"
---

# update-docs

変更差分から、ユーザー向け挙動・設定・運用・architecture contractが変わったか確認する。変わっていなければ文書を触らない。

必要な場合だけ、関連するREADME/docs/example configを更新する。コードから導出できる細部を重複記載せず、既存のcanonical documentへ寄せる。

古い名称・設定例・経路が残っていないか、変更した用語と旧用語を検索して確認する。
