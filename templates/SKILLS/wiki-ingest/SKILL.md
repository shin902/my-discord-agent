---
name: "wiki-ingest"
description: "Ingest a new source into an LLM-maintained wiki: read it, summarize it, and integrate it across entity/concept pages, the index, and the log. Use when the user drops a file into raw/, shares a URL/article/PDF/note to file, or says things like 'ingest this', 'add this source', 'process this into the wiki', or 'file this away'."
---

# wiki-ingest

Integrate one source into the wiki so its knowledge is *compiled in*, not just stored. The goal is not a summary that sits alone — it's updating the whole connected graph so the next question is already answered. A single source typically touches 10–15 pages.

Read the root `CLAUDE.md` first; follow its conventions over anything here if they conflict.

## Procedure

### 1. Locate and read the source

The source lives in `raw/` (or the user just provided it — if so, save a copy into `raw/` first, since raw is the immutable record). Read it fully. For sources with images, read the text first, then view the referenced images separately for additional context — and write the key visual details into the summary as text so future reads don't need the images. For web articles, prefer a markdown capture (e.g. Obsidian Web Clipper) saved into `raw/`.

### 2. Discuss takeaways

Before writing, surface the key takeaways to the user in a few sentences: what's new here, what it confirms, what it contradicts. Let them steer emphasis. (Skip the back-and-forth only if the user asked for batch/unsupervised ingest.)

### 3. Write the source summary page

Create `wiki/sources/<slug>.md` with frontmatter (`type: source`, `created`/`updated` = today, `sources: []`, a link to the raw file). Include: a tight summary, the key claims/facts worth retaining, notable quotes or figures, and a `## Connections` section listing the entities and concepts it touches as `[[wikilinks]]`.

### 4. Propagate across the wiki

This is the real work. For each entity and concept the source touches:

- If a page exists, **update it** — add the new fact, strengthen or revise the synthesis, and add a citation to the source page.
- If a distinct entity/concept recurs or earns its own identity and has no page, **create one** (follow the `CLAUDE.md` new-page-vs-edit rule).
- **Flag contradictions explicitly.** When the new source disagrees with an existing claim, don't silently overwrite — note both, mark which is newer, and surface it. Add a `> ⚠️ Contradiction:` callout on the affected page.
- Add reciprocal `[[wikilinks]]` so connections are bidirectional, and update `overview.md` if the source shifts the big picture.

### 5. Update the index

Add the new source page (and any newly created entity/concept pages) to `wiki/index.md` under the right category, each as `[[page]] — one-line summary`.

### 6. Append to the log

```
## [YYYY-MM-DD] ingest | <source title>
- summary: wiki/sources/<slug>.md
- touched: [[page-a]], [[page-b]], [[page-c]], …
- contradictions: <none | brief note>
```

### 7. Report

Tell the user concisely: what page was created, which pages were updated/created, and any contradictions flagged — so they can browse the changes (e.g. in Obsidian's graph view).

## Notes

- Stay disciplined about citations: every new claim on a wiki page traces back to a source page.
- Prefer touching more pages with small, accurate edits over one big dump on the summary page — the value is in the cross-references.
- If the source is large, you can shell out to the `wiki-search` helper to find which existing pages already mention its entities before deciding create-vs-edit.
