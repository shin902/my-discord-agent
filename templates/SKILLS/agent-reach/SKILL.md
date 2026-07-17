---
name: agent-reach
description: URL からコンテンツを取得して整形するスキル。YouTube, GitHub, Reddit, RSS, X/Twitter, 一般 Web ページに対応。これらのサービスのURLから情報を取得するときは必ず使うこと。
---

## 使い方

`agent-reach` ツールへURLを渡す。整形されたMarkdownがツール結果として返る。

```json
{"url":"https://example.com/article"}
```

URL取得のために`bash`や`curl`を使わないこと。取得結果は通常そのまま読み、明確に必要な場合だけ別のファイルツールで保存する。
