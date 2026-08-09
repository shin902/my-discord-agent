---
name: agent-reach
description: Fetch and format content from URLs. Supports YouTube, GitHub, Reddit, RSS, X/Twitter, and general web pages. Always use it when retrieving information from one of these service URLs.
---

## Usage

Formatted text is written to stdout (Markdown for web, YouTube, GitHub, Reddit, and X; feedparser JSON for RSS).

### When no file output is needed, run it directly without redirection

```bash
SKILLS/agent-reach/scripts/agent-reach.sh <URL>
```

### Use redirection only when saving to a file is explicitly required

```bash
SKILLS/agent-reach/scripts/agent-reach.sh https://www.youtube.com/watch?v=xxxxx > video.md
```

## シェル版で取得に失敗した場合

1. 初回は URL の query をそのまま付けて実行する（fragment だけはスクリプトが除去する）。
2. 失敗時に再試行する場合だけ、`utm_*`、`fbclid`、`gclid` など明らかな追跡パラメータを削除する。
3. `id`、`sort`、検索条件、署名など内容や認証を決めるパラメータは残し、query 全体を一律に削除しない。
