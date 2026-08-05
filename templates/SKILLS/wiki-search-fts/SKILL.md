---
name: "wiki-search-fts"
description: "Search the full contents of an LLM-managed wiki. Use this during ingest (before deciding whether to create or edit an entity page, to find pages that already mention it), query (to identify relevant pages), or lint (to find every page mentioning a concept and check missing cross-references)."
---

# wiki-search-fts

Full-text search for large wikis where `wiki-search`'s custom TF scoring is no longer sufficient. It uses SQLite's built-in **FTS5** (the VIRTUAL TABLE feature for full-text search) and calculates BM25 rankings with SQLite's built-in `bm25()` function. It uses no external packages and runs with only Python's standard-library `sqlite3` module (native dependencies such as `node-llama-cpp` and `sqlite-vec` are unnecessary).

Do not enable this at the same time as `wiki-search`. Both descriptions use the same wording without distinguishing the two, so placing both under `SKILLS/` makes skill selection nondeterministic. When enabling this skill, remove `wiki-search` from `SKILLS/`.

## Usage

```
python3 SKILLS/wiki-search-fts/scripts/search.py "<query>" [WIKI_DIR]      # ./wiki is used when WIKI_DIR is omitted
```

On the first run, create the index database file `.wiki-search-fts.sqlite3` directly under `WIKI_DIR`. Later runs reuse this database, detect changes from each `.md` file's mtime and size, and re-index only files that changed (there is no full scan on every run). Deleted files are also automatically removed from the index.

Results are ranked with FTS5's `MATCH` operator and BM25 scores (`bm25()` returns smaller values for better matches, so the displayed score is sign-inverted), then the top pages are shown with their file paths and the lines with the strongest matches (excerpts).

## When to use it

- **Ingest** — Before deciding whether to create a new page or edit an existing page for an entity, search for its name and check which existing pages already mention it.
- **Query** — Find candidate pages when the answer is not obvious from the index. Then follow `[[wikilinks]]` from the top search results.
- **Lint** — Identify every page that mentions a concept and check for missing cross-references.
- **Migrating from wiki-search** — If `wiki-search`'s SKILL.md advises that migration should be considered as the number of documents grows, propose switching to this skill and use it once the user agrees.

## FTS5-specific behavior

- **VIRTUAL TABLE**: Index page content as an FTS5 virtual table with three columns, `path`, `title`, and `body` (`raw_body` is a non-indexed column used only for displaying excerpts). SQL manages the full-text index structure directly, so custom TF-calculation logic is unnecessary.
- **MATCH operator**: Pass the query as `WHERE pages MATCH ?`. Each query term is wrapped in double quotes as a phrase token and OR-joined, preventing FTS5 reserved characters such as `*` and `^` from being interpreted as syntax. The SQL statement itself is always passed with parameter binding (`?`), leaving no opportunity for SQL injection.
- **BM25 rank**: Calculate the BM25 score with SQLite's built-in `bm25(pages)` function. By design, smaller (more negative) values indicate higher relevance, so the sign is reversed for display.
- **Japanese tokenization caveat**: Although the tokenizer is `tokenize = 'porter unicode61'`, `unicode61` is a simple tokenizer that splits on whitespace and punctuation. In languages without spaces, such as Japanese, an entire sentence would become one token and searches would fail. To avoid this, `search.py` preprocesses both indexing and query input by expanding runs of CJK characters (hiragana, katakana, and kanji) into character bigrams (overlapping two-character windows; for example, 「東京都」→「東京」「京都」). This is not morphological analysis, so accuracy will be lower than for English.
- **Misses caused by word order**: A compound without spaces (for example, 「東京情報」) remains one phrase token after bigram expansion and one OR-search unit, so it matches only when 「東京」 and 「情報」 are adjacent in the document (separate occurrences are missed). Conversely, separating multiple terms with spaces produces a word-level OR search, so pages containing either term will also match (there is no AND condition). Be aware that how a compound is written changes the precision/recall trade-off.

## If the wiki grows further

FTS5 BM25 is based on keyword matches and cannot capture semantic similarity (paraphrases or synonyms). If vector search or LLM re-ranking becomes necessary, consult the user about introducing an external tool such as **[qmd](https://github.com/tobi/qmd)** instead of forcing a heavy native dependency onto this skill or an Alpine container. qmd is a local Markdown search engine that performs hybrid BM25 + vector search and LLM re-ranking on-device, but it depends on `sqlite-vec` (a glibc-only prebuilt binary that does not support musl/Alpine) and `node-llama-cpp` (a heavyweight native build), so it cannot be added easily to this repository's sandbox container (`node:22-alpine`). Also explain that using it requires a configuration change such as running it on the host or preparing a separate glibc environment.
