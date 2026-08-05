---
name: "wiki-search"
description: "Search the full contents of an LLM-managed wiki. Use this during ingest (before deciding whether to create or edit an entity page, to find pages that already mention it), query (to identify relevant pages), or lint (to find every page mentioning a concept and check missing cross-references). When the wiki exceeds a few hundred pages, suggest migrating to wiki-search-fts."
---

# wiki-search

Lightweight full-text search for cases where the wiki has grown too large for reading only `index.md`. It searches the wiki’s Markdown files. There are no external dependencies — files are processed with pure Python.

## Usage

```
python3 SKILLS/wiki-search/scripts/search.py "<query>" [WIKI_DIR]      # If WIKI_DIR is omitted, ./wiki is used
```

Rank pages with a simple TF score over whitespace/word tokens (case-insensitive), adding a bonus when a match occurs in the title/frontmatter or a heading. Display the top pages together with each page’s highest-scoring matching line. Multi-word queries use OR search, and the score reflects how many query terms matched.

## When to use it

- **Ingest** — Before deciding whether to create a new page or edit an existing page for an entity, search for its name and check which existing pages already mention it.
- **Query** — Find candidate pages when the answer is not clear from the index. Then follow `[[wikilinks]]` from the top search results.
- **Lint** — Identify every page that mentions a concept and check for missing cross-references.

## When the wiki grows larger

This helper is intentionally simple (keyword TF, no stemming, no vectors). It works well up to a few hundred pages. Once the wiki grows beyond that, suggest that the user migrate to **`wiki-search-fts`**, which uses SQLite FTS5 (full-text search with built-in BM25 ranking). The user must explicitly enable this skill, so the agent cannot switch automatically — say something like 「wikiが大きくなってきたので、より高速・高精度な検索のために `wiki-search-fts` への移行を検討してみてください」. If migration is approved, update the root `AGENTS.md` so future sessions know which search tool to use. If vector search or LLM reranking becomes necessary as well, discuss introducing an external tool such as **[qmd](https://github.com/tobi/qmd)** with the user (note that qmd has native `sqlite-vec`/`node-llama-cpp` dependencies and can be difficult to run in an Alpine/musl-based environment).

Do not enable `wiki-search` and `wiki-search-fts` at the same time. Their descriptions use the same wording without distinguishing the two, so placing both under `SKILLS/` makes the selected skill nondeterministic. Once migration is complete, remove `wiki-search` from `SKILLS/`.
