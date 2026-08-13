---
name: "wiki-setup"
description: "Initialize a personal wiki maintained by an LLM using a three-layer raw → wiki → schema pattern. Use this when the user wants to start a knowledge base, build a wiki, or create an Obsidian vault for an agent, or says 「wikiを初期化して」, 「ナレッジベースをセットアップして」, or 「wiki構造を作って」."
---

# wiki-setup

Build a new LLM-managed wiki from the ground up. This is a persistent, cross-linked Markdown knowledge base that you (the agent) build and keep current whenever the user adds sources. It is a one-time initialization process. After setup, use `wiki-ingest`, `wiki-query`, and `wiki-lint` for daily work.

## Model overview (one paragraph)

The model has three layers. **Raw sources** (`raw/`) are immutable input data organized by the user — articles, PDFs, notes, images, and so on. The **wiki** (`wiki/`) is Markdown fully owned by you — summaries, entity pages, concept pages, an index, and a log. The **schema** (the root `AGENTS.md`) is the rulebook that turns you from a general-purpose chatbot into a disciplined wiki maintainer. The user organizes and asks questions; you handle all summarization, cross-referencing, organization, and recording.

## Procedure

### 1. Confirm the location and purpose

Work in the folder selected by the user. First, actually check (for example with `ls`; do not guess) whether the target folder already contains `AGENTS.md`, `wiki/`, or `raw/`. If any already exists, this is an addition or migration to an existing wiki rather than a new setup. Do not overwrite it; ask the user whether they want a rebuild, a new setup in another folder, or additions to the existing structure.

Once you have confirmed that none exists (a new build), ask the user directly what the wiki is for before constructing anything (do not settle for guesses; ask in ordinary conversation) — this determines the schema. At minimum, confirm the following:

- **Primary purpose**: personal knowledge management / deep research / reading log / a team- or domain-focused wiki / other.
- **What kinds of sources** will be added (articles, PDFs, meeting notes, papers, images, and so on) — this affects the operating rules for `raw/` and whether OCR or image-summarization processing is needed.
- **Update frequency and scale**: a few items per week or large daily ingests — this determines whether `wiki-search` is sufficient from day one or whether to plan an early migration to `wiki-search-fts` (SQLite FTS5-based and available when the user enables it) if the wiki is expected to exceed a few hundred pages.
- **Whether directory names, heading vocabulary, and filename conventions should remain in English or use Japanese**: by default, use the English directory names `sources/`, `entities/`, and `concepts/` and kebab-case filenames. If the user wants to operate entirely in Japanese, confirm here which naming policy to use for directory names, `index.md` headings, and filenames (romanize Japanese titles / translate them into English / keep Japanese and separate words with hyphens). Because Obsidian has constraints around filenames and links, do not ask them to choose without context; briefly explain the trade-off (English names are more compatible with examples for other Obsidian plugins, while Japanese names are easier to read) before they choose.

Do not proceed with construction until you have real answers rather than assumptions — reversing these decisions after pages exist is costly. If the user’s answers are ambiguous, ask follow-up questions instead of silently adopting the defaults.

### 2. Create the directory structure

```
<root>/
  AGENTS.md          # Schema (rulebook) — see step 3
  raw/               # Immutable source files (user-owned)
    assets/          # Downloaded images referenced by sources
  wiki/              # Markdown owned by the LLM
    index.md         # Catalog of all pages (content-oriented listing)
    log.md           # Append-only chronological record
    overview.md      # Top-level synthesis page / entry point
    sources/         # Summary pages for ingested sources
    entities/        # People, organizations, products, places, and so on
    concepts/        # Ideas, themes, and topics
```

The names above are the defaults (English). If Japanese operation was chosen in step 1, replace them with the vocabulary agreed during the interview, such as `sources/`→`出典/`, `entities/`→`エンティティ/`, and `concepts/`→`コンセプト/`. Record the choice in `AGENTS.md` below as well.

Create the folders and initialize `index.md`, `log.md`, and `overview.md` (see step 4). Do not invent content — provide only the structure and empty placeholder pages.

There must be exactly one `index.md` and one `log.md`, each directly under `wiki/` — do not create same-named pages in subdirectories (for example, `sources/index.md`). `wiki-lint` treats only the files at the wiki root specially.

### 3. Write `AGENTS.md` (the schema)

This is the most important file. It is loaded at the start of every future session and keeps the wiki consistent. Write it for the selected purpose. It must include the following:

- **Layers and rules**: `raw/` is the read-only source of truth, and `wiki/` is the area you write. Never edit `raw/`.
- **Page rules**: filenames (kebab-case; if Japanese operation was chosen in step 1, state the agreed romanization, English-translation, or Japanese-hyphenation policy here), one entity/concept per page, YAML frontmatter on every wiki page (see below), and `[[wikilinks]]` for cross-references so that Obsidian’s graph view works.
- **Criteria for creating a new page versus editing an existing one**: create a new page for an entity/concept that recurs across multiple sources or has an independent identity. Otherwise, integrate details into an existing page and add cross-references. Start with a small number of substantial pages and split sections when they become unwieldy.
- **Workflow**: refer to the ingest/search/lint procedures (the companion skills) and summarize each in one sentence so the agent can follow them even when the skills are not loaded.
- **Index and log discipline**: update `index.md` on every ingest. Append to `log.md` for every ingest, incorporation of search results, and lint run, using the prefix format `## [YYYY-MM-DD] <op> | <title>`. `log.md` is append-only: never rewrite it or read the whole file. To inspect it, call the `read` tool with its actual `tailCount` parameter, for example `tailCount: 20` (or `tailCount: 10`), to read only the last lines. Use `tailCount` for this tail-only read. Add entries with an append-only operation such as `printf ... >> log.md` or `cat >> log.md`; never use full-file `edit`/`write` or read-and-write-back scripts.
- **Citations**: cite the original source page for claims in the wiki. Source pages must link back to files under `raw/`.

Use the following frontmatter rules on every wiki page (Dataview/Bases-compatible):

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

### 4. Initialize navigation files

`index.md` — make this a catalog with headings and empty sections for each category (by default, Overview, Sources, Entities, and Concepts; if Japanese operation was chosen in step 1, use the agreed vocabulary such as 概要・出典・エンティティ・コンセプト). Under each section, use bullet points in the form `[[page]] — 一行要約`.

`log.md` — include only one heading and the first entry:
`## [<today>] setup | wiki initialized`

`overview.md` — a short stub stating the wiki’s purpose and that it will grow as sources are ingested. Link to `[[index]]`.

### 5. Optional tools

Present these as suggestions, not requirements: Obsidian as a viewing frontend (graph view, Web Clipper for collecting sources, Bases/Dataview for frontmatter, and Marp for slides); `git init` for free version history; and search tooling once the wiki outgrows what the index file can handle (the `wiki-search` helper, migration to `wiki-search-fts` after a few hundred pages, and, if vector search is later needed, discussing an external tool such as `qmd` with the user). Do not enable `wiki-search` and `wiki-search-fts` simultaneously; when migrating, remove the former from `SKILLS/`.

### 6. Install related skills

Run the following with the directory names finalized during the interview as arguments:

```bash
bash /workspace/SKILLS/wiki-setup/setup.sh <WIKI_ROOT> <RAW_DIR> <DIGEST_DIR>
```

Example: `bash /workspace/SKILLS/wiki-setup/setup.sh llm-wiki llm-wiki/raw llm-wiki/digest`

This script copies the bundled wiki-ingest, wiki-lint, and wiki-query from `wiki-setup/SKILLS/` to `/workspace/SKILLS/`, then replaces placeholders (such as `{{WIKI_ROOT}}`) with the actual paths in one pass. Existing skills are skipped (existing skills are never touched).

### 7. Hand off

Tell the user that the structure is ready, show the tree, and explain the operating flow: place sources in `raw/` → run ingest → ask questions through search → run lint regularly. Before finishing, verify that the purpose section of `AGENTS.md` matches what the user wants.
