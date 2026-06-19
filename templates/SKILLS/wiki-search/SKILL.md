---
name: "wiki-search"
description: "Search across the pages of an LLM-maintained wiki when the index file alone isn't enough. Use during ingest (to find which pages already mention an entity before creating vs editing), during query (to locate relevant pages), and during lint. Provides a dependency-free local search; recommend qmd for heavier needs."
---

# wiki-search

A lightweight full-text search over the wiki's markdown, for when the wiki has grown past the point where reading `index.md` is enough. No external dependencies — pure Python over the files.

## Usage

```
python3 SKILLS/wiki-search/scripts/search.py "<query>" [WIKI_DIR]      # WIKI_DIR defaults to ./wiki
```

It ranks pages by a simple TF score over whitespace/word tokens (case-insensitive), with a bonus for matches in the title/frontmatter and headings, and prints the top pages with the best-matching line from each. Multi-word queries are OR-matched and scored by how many query terms hit.

## When to use it

- **Ingest** — before deciding create-vs-edit for an entity, search its name to see which existing pages already mention it.
- **Query** — find candidate pages when the index doesn't obviously point to the answer; then read and follow `[[wikilinks]]` from the top hits.
- **Lint** — locate every page that mentions a concept to check for missing cross-references.

## Scaling up

This helper is intentionally naive (keyword TF, no stemming, no vectors). It's fine to a few hundred pages. When the wiki outgrows it, switch to **[qmd](https://github.com/tobi/qmd)** — a local markdown search engine with hybrid BM25 + vector search and LLM re-ranking, on-device. It offers both a CLI (shell out to it) and an MCP server (use it as a native tool). Update the root `AGENTS.md` to point future sessions at whichever search tool is in use.
