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
