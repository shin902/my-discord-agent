---
name: "wiki-lint"
description: "Check the health of an LLM-managed wiki: find contradictions, stale claims, orphan pages, missing cross-references, undocumented concepts, and missing data, then propose fixes. Use this when asked 「wikiをlintして」, 「健全性チェックして」, 「ナレッジベースを整理して」, or 「ギャップを見つけて」, or periodically after many ingests."
---

# wiki-lint

Keep the wiki healthy as it grows. People abandon wikis when the cost of maintenance exceeds their value; this skill makes that maintenance inexpensive. Produce a report that summarizes issues and proposed fixes, and apply safe fixes only with the user's permission.

First read the root `AGENTS.md` and follow its conventions.

## Checks

First run the `SKILLS/wiki-lint/scripts/lint.py` helper for mechanical checks (orphan pages, broken links, missing frontmatter, and date staleness), then read pages for judgment-based checks.

**Mechanical checks (script-assisted):**
- **Orphan pages** — Pages not linked from any other page with `[[wikilinks]]`. Add a link or explain why the page should remain as-is.
- **Broken links** — `[[wikilinks]]` that point to pages that do not exist. Create the page or fix the link.
- **Missing or invalid frontmatter** — Pages missing required YAML fields.
- **Index drift** — Pages present on disk but not listed in `index.md`, or index entries that point to deleted pages.
- **Misplaced index/log pages** — The script special-cases only `index.md`/`log.md` directly under the wiki root. Same-named pages in subdirectories (for example, `sources/index.md`) are flagged separately and treated as candidates for renaming.
- **Date-based staleness** — Pages that have not been updated for a long time even though their related sources have been updated.

**Judgment-based checks (read the pages):**
- **Contradictions** — Claims that conflict across pages. Flag both, indicate which is newer, and propose a resolution.
- **Stale claims** — Statements superseded by newer sources but not yet updated.
- **Missing cross-references** — Pages that are clearly related but do not link to each other.
- **Undocumented concepts** — Entities or concepts mentioned on multiple pages without a dedicated page.
- **Missing data** — Unresolved questions that could be answered with web searches or new sources. Propose specific search queries and references.

## Procedure

1. Run `python3 SKILLS/wiki-lint/scripts/lint.py {{WIKI_ROOT}}/wiki` (the default is `./wiki`). It outputs a structured report of mechanical issues.
2. Read flagged pages and a sample of unflagged pages to perform the judgment-based checks.
3. Produce a findings report grouped by category, with a concrete proposed fix for each item.
4. Apply safe, unambiguous fixes (adding missing backlinks, registering pages in the index, and adding frontmatter). Always ask for confirmation before operations that could lose information (merging pages, deleting orphan pages, or resolving a contradiction by choosing one side).
5. Append a log entry:
   `## [YYYY-MM-DD] lint | <N issues found, M fixed, K need decisions>`
6. Finally, provide a brief list of questions to investigate or sources to find next — lint also tells you what to read next in the wiki.

## Notes

- This script is read-only and never edits the wiki. Route all changes through the agent and obtain the user's approval.
- Run lint after a batch ingest or periodically on a schedule (it works well with a scheduled task).
