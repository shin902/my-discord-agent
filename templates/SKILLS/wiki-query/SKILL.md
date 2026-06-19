---
name: "wiki-query"
description: "Answer a question against an LLM-maintained wiki with citations, and file durable answers back as new wiki pages so explorations compound. Use when the user asks a question about their knowledge base, says 'what does the wiki say about…', 'compare X and Y from my notes', 'synthesize…', or wants an answer drawn from their accumulated sources."
---

# wiki-query

Answer the user's question from the wiki, with citations — and, when the answer is durable, file it back so the exploration becomes part of the knowledge base instead of disappearing into chat history.

Read the root `AGENTS.md` first and follow its conventions.

## Procedure

### 1. Find the relevant pages

Read `wiki/index.md` first to locate candidate pages, then drill into them. For larger wikis, shell out to the `wiki-search` helper (or `qmd`) for ranked full-text search instead of relying on the index alone. Follow `[[wikilinks]]` outward from the most relevant pages — the connections are often where the answer lives.

### 2. Synthesize an answer

Compose the answer from what the pages say. Cite the pages you drew from as `[[page]]` (and, through them, the underlying sources). If the wiki only partially answers the question, say so plainly and distinguish what's grounded in sources from what's inference. If there's a relevant gap, offer to fill it with a web search or a new source.

### 3. Choose the answer's form

Match the format to the question:

- a short prose answer for simple questions,
- a markdown comparison table for "X vs Y",
- a Marp slide deck for a presentation-shaped ask,
- a matplotlib chart for something quantitative,
- a new synthesis page for a broad "pull this together" request.

### 4. File durable answers back

This is what makes the wiki compound. If the answer is more than a quick lookup — a comparison, an analysis, a discovered connection, a synthesis — file it back as a new page:

- Create `wiki/concepts/<slug>.md` (or a `wiki/syntheses/` page) with normal frontmatter, marking it as a derived/answer page in `tags`.
- Add `[[wikilinks]]` to every page it draws on, and add reciprocal links back from those pages.
- Add it to `wiki/index.md`.
- Append a log entry:
  `## [YYYY-MM-DD] query | <question> → filed as [[page]]`

Ask the user before filing if it's ambiguous whether the answer is worth keeping; for clearly durable results, file it and tell them. Don't file ephemeral lookups ("what year was X published") — those add noise.

### 5. Report

Give the user the answer, the citations, and — if you filed something — the new page name so they can browse it.

## Notes

- Never fabricate citations. If a claim isn't on a page, mark it as your own inference.
- Surface contradictions you encounter while answering rather than silently picking one side — they're often the most interesting part, and may warrant a `wiki-lint` follow-up.
