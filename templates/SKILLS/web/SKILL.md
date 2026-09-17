---
name: web
description: Search the web, papers, GitHub activity, Hacker News, and X, or fetch a known URL.
---

# Web

Pass the capability's JSON arguments unchanged:

```bash
bash SKILLS/web/scripts/web.sh tavily-search '{"query":"Strix Halo ROCm","max_results":10}'
bash SKILLS/web/scripts/web.sh agent-reach '{"url":"https://example.com"}'
bash SKILLS/web/scripts/web.sh arxiv-search '{"query":"speculative decoding","max_results":20}'
```

Capabilities and uses:

- `tavily-search`: general web search, current information, and fact checking
- `agent-reach`: fetch and normalize a known URL
- `arxiv-search`: focused paper search
- `arxiv-survey`: search several paper queries together
- `hackernews-search`: recent Hacker News stories
- `github-recent-search`: recent public GitHub issues and pull requests
- `x-search`: search X posts

The script does not parse or transform arguments. Use the capability's canonical Tool schema when constructing the JSON object.
