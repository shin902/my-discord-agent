---
name: agent-reach
description: URL からコンテンツを取得して整形するスキル。YouTube, GitHub, Reddit, RSS, X/Twitter, 一般 Web ページに対応。これらのサービスのURLから情報を取得するときは必ず使うこと。
---

## 使い方

stdout に整形された Markdown が出力される。

### ファイル出力が必要ない場合は、リダイレクトを使用せずにそのまま実行すること

```bash
SKILLS/agent-reach/scripts/agent-reach.sh <URL>
```

### ファイル保存が明確に必要な場合のみ、リダイレクトを使用する

```bash
SKILLS/agent-reach/scripts/agent-reach.sh https://www.youtube.com/watch?v=xxxxx > video.md
```
