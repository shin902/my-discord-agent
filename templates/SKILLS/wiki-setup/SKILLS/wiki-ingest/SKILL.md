---
name: "wiki-ingest"
description: "Ingest a new source into an LLM-managed wiki: read it, summarize it, and integrate it across entity/concept pages, the index, and the log. Use this when the user places a file in raw/, shares a URL/article/PDF/note, or says 「これを取り込んで」, 「このソースを追加して」, 「wikiに反映して」, or 「これをファイルしておいて」."
---

# wiki-ingest

Integrate one source into the wiki and *incorporate* its knowledge rather than merely storing it. The goal is not an isolated summary, but to update the connected graph as a whole so that it can already answer follow-up questions. A single source typically affects 10–15 pages.

First read `AGENTS.md` in the target wiki directory. If anything conflicts, follow that file’s conventions over the instructions here.

## Procedure

### 1. Identify and read the source

The source is in `{{RAW_DIR}}/` (or, if the user has just provided it, first save a copy in `{{RAW_DIR}}/` because raw is the immutable record). Read it in full. For a source containing images, read the text first, then inspect each referenced image separately for additional context. Write important visual details into the summary as text so future reads do not need to revisit the images. For web articles, prefer saving a Markdown capture (for example, from Obsidian Web Clipper) in `{{RAW_DIR}}/`.

### 2. Discuss the key points

Before writing, present the key points to the user in a few sentences: what is new, what it supports, and what it contradicts. Let the user choose the emphasis (skip this exchange only when the user requests batch/unattended ingestion).

### 3. Write the source summary page

In the source-page directory (following the conventions defined in `AGENTS.md`; by default `{{DIGEST_DIR}}/`), create `<slug>.md` with frontmatter (`type: source`, today’s date for `created`/`updated`, `sources: []`, and a link to the raw file). Include a concise summary, important claims/facts to preserve, notable quotations or numbers, and a `## Connections` section listing the entities and concepts touched by the source as `[[wikilinks]]`.

### 4. Apply the source across the wiki

This is the core of the work. For each entity or concept touched by the source:

- If a page already exists, **update it** — add new facts, strengthen or correct the integrated explanation, and cite the source page.
- If a clear entity/concept recurs and has its own identity but no page exists, **create one** (following the `AGENTS.md` rules for creating versus editing).
- **Flag contradictions explicitly.** If the new source conflicts with an existing claim, do not silently overwrite it; record both, indicate which is newer, and surface the conflict. Add a `> ⚠️ Contradiction:` callout to affected pages.
- Add reciprocal `[[wikilinks]]` so connections work in both directions, and update `overview.md` when the source changes the overall picture.

### 5. Update the index

Add the new source page (and any newly created entity/concept pages) to `{{WIKI_ROOT}}/index.md` under the appropriate category, using the form `[[page]] — 一行要約`.

### 6. Append to the log (never rewrite it)

`{{WIKI_ROOT}}/log.md` is an append-only chronological record and may grow beyond the context window. Before adding an entry, do not read the whole file: call the `read` tool with its actual `tailCount` parameter, for example `tailCount: 20` (or `tailCount: 10`), to inspect only the last lines. Use `tailCount` for this tail-only read. Add the entry with an append-only operation such as `printf ... >> {{WIKI_ROOT}}/log.md` or `cat >> {{WIKI_ROOT}}/log.md`. Never use full-file `edit`/`write`, `sed -i`, or a read-and-write-back script for `log.md`; preserve every existing entry.

```
## [YYYY-MM-DD] ingest | <source title>
- summary: <ソースページ用ディレクトリ>/<slug>.md
- touched: [[page-a]], [[page-b]], [[page-c]], …
- contradictions: <none | brief note>
```

### 7. Report

Tell the user briefly which source page was created, which entity/concept pages were updated or created, and whether any contradictions were flagged. This lets them review the changes (for example, in Obsidian’s graph view).

## Notes

- Keep citation discipline: every new claim on a wiki page must be traceable to the source page.
- Prefer small, accurate edits across more pages over dumping a large amount of information into the summary page — the value is in the cross-references.
- For a large source, use the `wiki-search` helper to check which existing pages already mention the entity before deciding whether to create or edit a page.
