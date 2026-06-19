---
name: "wiki-lint"
description: "Health-check an LLM-maintained wiki: find contradictions, stale claims, orphan pages, missing cross-references, undocumented concepts, and data gaps, then propose fixes. Use when the user says 'lint the wiki', 'health check', 'clean up the knowledge base', 'find gaps', or periodically after many ingests."
---

# wiki-lint

Keep the wiki healthy as it grows. Humans abandon wikis because maintenance outpaces value; this pass is the maintenance, done cheaply. Produce a report of issues with proposed fixes, and apply the safe ones with the user's go-ahead.

Read the root `AGENTS.md` first and follow its conventions.

## What to check

Run the `SKILLS/wiki-lint/scripts/lint.py` helper first for the mechanical checks (orphans, broken links, missing frontmatter, stale dates), then do the judgment-based checks by reading pages.

**Mechanical (script-assisted):**
- **Orphan pages** — pages with no inbound `[[wikilinks]]`. Either link them in or justify keeping them.
- **Broken links** — `[[wikilinks]]` pointing to pages that don't exist. Create the page or fix the link.
- **Missing/invalid frontmatter** — pages lacking the required YAML fields.
- **Index drift** — pages on disk not listed in `index.md`, or index entries pointing to deleted pages.
- **Stale by date** — pages not updated in a long time relative to sources that should have touched them.

**Judgment-based (read the pages):**
- **Contradictions** — claims on different pages that disagree. Flag both, mark which is newer, propose a resolution.
- **Stale claims** — statements a newer source has superseded but that were never revised.
- **Missing cross-references** — pages that clearly relate but don't link each other.
- **Undocumented concepts** — entities/concepts mentioned across pages but lacking their own page.
- **Data gaps** — open questions a web search or a new source could resolve. Suggest specific searches/sources.

## Procedure

1. Run `python3 SKILLS/wiki-lint/scripts/lint.py <wiki-dir>` (defaults to `./wiki`). It prints a structured report of the mechanical issues.
2. Read the flagged pages plus a sample of the rest for the judgment-based checks.
3. Write a findings report grouped by category, each item with a concrete proposed fix.
4. Apply the safe, unambiguous fixes (add a missing back-link, register a page in the index, add frontmatter). Ask before anything lossy — merging pages, deleting orphans, resolving a contradiction by picking a side.
5. Append a log entry:
   `## [YYYY-MM-DD] lint | <N issues found, M fixed, K need decisions>`
6. End with a short list of suggested next questions to investigate and sources to look for — linting is also where the wiki tells you what to read next.

## Notes

- The script is read-only; it never edits the wiki. All changes go through you with user sign-off.
- Run lint after every batch of ingests, or on a schedule (it pairs well with a recurring scheduled task).
