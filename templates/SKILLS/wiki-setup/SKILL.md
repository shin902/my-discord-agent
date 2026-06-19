---
name: "wiki-setup"
description: "Bootstrap an LLM-maintained personal wiki (the raw → wiki → schema three-layer pattern). Use when the user wants to start a new knowledge base, set up a wiki, scaffold an Obsidian vault for an agent, or says things like 'initialize the wiki', 'set up my knowledge base', or 'create the wiki structure'."
---

# wiki-setup

Scaffold a fresh LLM-maintained wiki: a persistent, interlinked markdown knowledge base that you (the agent) build and keep current as the user adds sources. This is the one-time initializer. After setup, day-to-day work uses `wiki-ingest`, `wiki-query`, and `wiki-lint`.

## The model in one paragraph

Three layers. **Raw sources** (`raw/`) are immutable inputs the user curates — articles, PDFs, notes, images. **The wiki** (`wiki/`) is markdown you own entirely — summaries, entity pages, concept pages, an index, a log. **The schema** (`AGENTS.md` at the root) is the rulebook that turns you from a generic chatbot into a disciplined wiki maintainer. The user curates and asks; you do all the summarizing, cross-referencing, filing, and bookkeeping.

## Steps

### 1. Confirm location and purpose

Work in the user's selected folder. Before scaffolding anything, ask the user directly (in plain conversation, not just inferring) what the wiki is for — this shapes the schema. At minimum, ask:

- **Primary purpose**: personal knowledge / research deep-dive / reading a book / team or domain wiki / something else.
- **What kinds of sources** will feed it (articles, PDFs, meeting notes, papers, images...) — affects `raw/` conventions and whether OCR/image-summary handling matters.
- **Update cadence and scale**: a few sources a week vs. heavy daily ingest — affects whether `wiki-search` is enough from day one or `qmd` should be set up immediately.

Don't proceed to scaffolding until you have real answers, not assumptions — these decisions are expensive to unwind once pages exist. If the user is vague, ask a follow-up rather than defaulting silently.

### 2. Create the directory structure

```
<root>/
  AGENTS.md          # the schema (rulebook) — see step 3
  raw/               # immutable source files (user-owned)
    assets/          # downloaded images referenced by sources
  wiki/              # LLM-owned markdown
    index.md         # catalog of every page (content-oriented)
    log.md           # append-only chronological record
    overview.md      # the top-level synthesis / entry point
    sources/         # one summary page per ingested source
    entities/        # people, orgs, products, places, etc.
    concepts/        # ideas, themes, topics
```

Create the folders and seed `index.md`, `log.md`, and `overview.md` (see step 4). Don't invent content — only structure plus empty/placeholder pages.

### 3. Write AGENTS.md (the schema)

This is the most important file. It is read at the start of every future session and is what keeps the wiki consistent. Write it tailored to the chosen purpose. It must cover:

- **Layers & rules**: `raw/` is read-only source-of-truth; `wiki/` is yours to write; never edit `raw/`.
- **Page conventions**: file naming (kebab-case), one entity/concept per page, YAML frontmatter on every wiki page (see below), `[[wikilinks]]` for cross-references so Obsidian's graph view works.
- **When to create a new page vs. edit an existing one**: create a page when a distinct entity/concept recurs across sources or earns its own identity; otherwise fold the detail into an existing page and add a cross-reference. Err toward fewer, richer pages early on; split when a section outgrows its host.
- **Workflows**: point to the ingest / query / lint procedures (the companion skills) and summarize each in a sentence so the agent follows them even without the skill loaded.
- **Index & log discipline**: update `index.md` on every ingest; append to `log.md` for every ingest, query-filed-back, and lint pass, using the prefix format `## [YYYY-MM-DD] <op> | <title>`.
- **Citations**: wiki claims cite their source page; source pages link back to the file in `raw/`.

Use this frontmatter convention on every wiki page (Dataview/Bases-friendly):

```yaml
---
title: <human title>
type: source | entity | concept | overview
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: [<source-page-slugs>]
tags: []
---
```

A ready-to-edit starter is in `assets/AGENTS.md.template` — copy it to the root and adapt the purpose-specific sections.

### 4. Seed the navigation files

`index.md` — headed catalog with empty category sections (Overview, Sources, Entities, Concepts), each a bulleted list of `[[page]] — one-line summary`.

`log.md` — a single header plus the first entry:
`## [<today>] setup | wiki initialized`

`overview.md` — a short stub stating the wiki's purpose and that it will grow as sources are ingested. Link `[[index]]`.

### 5. Optional tooling

Mention, don't force: Obsidian as the browsing frontend (graph view, Web Clipper for capturing sources, Bases/Dataview over frontmatter, Marp for slides); `git init` so the wiki gets free version history; a search tool (the `wiki-search` helper, or `qmd`) once the wiki outgrows the index file.

### 6. Hand off

Tell the user the structure is ready, show the tree, and explain the loop: drop sources into `raw/` → run ingest → ask questions via query → run lint periodically. Confirm the `AGENTS.md` purpose section matches what they want before finishing.
