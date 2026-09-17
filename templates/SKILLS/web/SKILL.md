---
name: web
description: Search the web, papers, GitHub activity, Hacker News, and X, or fetch a known URL.
---

# Web

Capabilities and uses:

- `tavily-search`: general web search, current information, and fact checking
- `agent-reach`: fetch and normalize a known URL
- `arxiv-search`: focused paper search
- `arxiv-survey`: search several paper queries together
- `hackernews-search`: recent Hacker News stories
- `github-recent-search`: recent public GitHub issues and pull requests
- `x-search`: search X posts

First retrieve only the capability you need, then follow its description (including safety requirements) and parameters when constructing raw JSON:

```bash
# Read the canonical Tool contract without executing it
bash SKILLS/web/scripts/web.sh tavily-search
# Execute with JSON matching that contract
bash SKILLS/web/scripts/web.sh tavily-search '{"query":"Strix Halo ROCm"}'
```

The script does not parse or transform arguments. Skill selection does not grant permission: the run must allow the capability through native `tools` or trusted `toolSets` (normally `web`).
