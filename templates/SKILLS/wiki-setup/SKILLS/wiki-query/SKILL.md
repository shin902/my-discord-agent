---
name: "wiki-query"
description: "Answer questions about an LLM-managed wiki with citations, and write answers with lasting value back as new wiki pages so the research accumulates. Use this when the user asks about the knowledge base, says 「wikiには〜について何が書いてある？」, 「自分のノートからXとYを比較して」, or 「〜を統合して」, or requests an answer based on accumulated sources."
---

# wiki-query

Answer the user's questions with citations based on the wiki. When an answer has lasting value, write it back so the result becomes part of the knowledge base instead of disappearing into the chat history.

First read the root `AGENTS.md` and follow its conventions.

## Procedure

### 1. Find relevant pages

Read `{{WIKI_ROOT}}/index.md` first to identify candidate pages, then dig deeper from there. For a large wiki, do not rely on the index alone: run the `wiki-search` helper (for wikis with hundreds of pages, `wiki-search-fts` if the user has enabled it) to perform a ranked full-text search. Follow `[[wikilinks]]` from the most relevant pages — the answer is often found in the connections. If the search is advanced enough to require vector search or LLM reranking, ask the user about installing an external tool such as `qmd`.

### 2. Synthesize the answer

Build the answer from the contents of the pages. Cite referenced pages as `[[page]]` (and thereby show the underlying sources through those pages). If the wiki only partially answers the question, state that clearly and distinguish source-backed portions from inferences. If relevant gaps remain, propose filling them with web searches or new sources.

### 3. Choose the answer format

Choose a format that matches the question.

- For a simple question, answer in a short paragraph.
- For 「XとYの比較」, use a Markdown comparison table.
- For a presentation-format request, use a Marp slide deck.
- For quantitative material, use a matplotlib chart.
- For a broad 「まとめて」 request, create a new synthesis page.

### 4. Write back lasting answers

This is how the wiki accumulates knowledge. If the answer is more than a simple lookup — a comparison, analysis, discovered connection, or synthesis — write it back as a new page.

- Create `<slug>.md` with standard frontmatter in the concept-page directory (following the conventions defined in `AGENTS.md`; by default `{{WIKI_ROOT}}/concepts/`, or as a page under `{{WIKI_ROOT}}/syntheses/`), and mark `tags` to show that it is a derived/answer page.
- Add `[[wikilinks]]` to every page referenced by the new page, and add reciprocal links from those pages.
- Add it to `{{WIKI_ROOT}}/index.md`.
- Append a log entry.
  `## [YYYY-MM-DD] query | <question> → filed as [[page]]`

If it is unclear whether an answer is worth preserving, ask the user before writing it back. For results with clear lasting value, write them back first and then tell the user. Do not write back temporary lookups (such as 「Xが出版されたのは何年？」) — they add noise.

### 5. Report

Present the answer and sources to the user. If anything was written back, also provide the new page name for future reference.

## Additional notes

- Never fabricate citations. Explicitly identify claims that are not written on a page as your own inferences.
- If you find a contradiction in the answer, state it rather than silently choosing one account — contradictions are often the most interesting part and may require a `wiki-lint` follow-up.
