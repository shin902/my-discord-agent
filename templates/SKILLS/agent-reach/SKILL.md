---
name: agent-reach
description: URL からコンテンツを取得して整形するスキル。YouTube, GitHub, Reddit, RSS, X/Twitter, 一般 Web ページに対応。左のサービスのURLから情報を取得するときは必ず使うこと。
---

## 使い方

```bash
SKILLS/scripts/agent-reach.sh <URL>
```

stdout に整形された Markdown が出力される。ファイルに保存するにはリダイレクトを使う。

```bash
./scripts/agent-reach.sh https://www.youtube.com/watch?v=xxxxx > video.md
```
