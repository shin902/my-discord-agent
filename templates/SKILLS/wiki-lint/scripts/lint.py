#!/usr/bin/env python3
"""Read-only health checker for an LLM-maintained wiki.

Reports mechanical issues only — it never edits the wiki. The agent reads this
report, does the judgment-based checks, and applies fixes with the user's sign-off.

Usage:
    python3 lint.py [WIKI_DIR]      # WIKI_DIR defaults to ./wiki
"""
import os
import re
import sys
from datetime import date

WIKILINK = re.compile(r"\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]")
FRONTMATTER = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
REQUIRED_FIELDS = ("title", "type", "created", "updated")
STALE_DAYS = 120


def slug(path, root):
    """Unique key for a page: relative path without extension (e.g. 'entities/alice')."""
    rel = os.path.relpath(path, root)
    return os.path.splitext(rel)[0].replace(os.sep, "/")


def normalize_name(name):
    """Normalize a name the same way a [[wikilink]] target is normalized, so
    filename-derived keys and link-derived keys are comparable."""
    return name.strip().lower().replace(" ", "-")


def basename_slug(path):
    """Bare name a [[wikilink]] refers to, e.g. 'alice' for both entities/alice.md and concepts/alice.md.
    Normalized to match wikilink targets (kebab-case filenames are a convention, not a guarantee)."""
    return normalize_name(os.path.splitext(os.path.basename(path))[0])


def parse_frontmatter(text):
    m = FRONTMATTER.match(text)
    if not m:
        return None
    fm = {}
    for line in m.group(1).splitlines():
        if ":" in line and not line.startswith(" "):
            k, _, v = line.partition(":")
            fm[k.strip()] = v.strip()
    return fm


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "wiki"
    if not os.path.isdir(root):
        print(f"error: wiki dir not found: {root}", file=sys.stderr)
        sys.exit(1)

    pages = {}          # unique slug (relpath w/o ext) -> path
    by_basename = {}    # bare wikilink name -> list of unique slugs sharing it
    outlinks = {}       # unique slug -> set(target bare names)
    inlinks = {}        # unique slug -> count
    no_frontmatter = []
    bad_frontmatter = []
    stale = []
    today = date.today()

    md_files = []
    for dirpath, _, files in os.walk(root):
        for f in files:
            if f.endswith(".md"):
                md_files.append(os.path.join(dirpath, f))

    SPECIAL = {"index", "log"}

    for path in md_files:
        s = slug(path, root)
        b = basename_slug(path)
        pages[s] = path
        by_basename.setdefault(b, []).append(s)
        inlinks.setdefault(s, 0)
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        outlinks[s] = set(normalize_name(m.group(1)) for m in WIKILINK.finditer(text))
        if b in SPECIAL:
            continue
        fm = parse_frontmatter(text)
        if fm is None:
            no_frontmatter.append(s)
        else:
            missing = [k for k in REQUIRED_FIELDS if k not in fm]
            if missing:
                bad_frontmatter.append((s, missing))
            upd = fm.get("updated", "")
            m = re.match(r"(\d{4})-(\d{2})-(\d{2})", upd)
            if m:
                try:
                    d = date(*map(int, m.groups()))
                    if (today - d).days > STALE_DAYS:
                        stale.append((s, upd, (today - d).days))
                except ValueError:
                    pass

    # bare names that resolve to more than one page (e.g. entities/alice.md and concepts/alice.md)
    collisions = {b: sorted(slugs) for b, slugs in by_basename.items()
                  if len(slugs) > 1 and b not in SPECIAL}

    # resolve inbound links, broken links, and ambiguous links (collisions referenced by a wikilink)
    broken = {}
    ambiguous = {}
    for s, targets in outlinks.items():
        for t in targets:
            candidates = by_basename.get(t, [])
            if len(candidates) == 1:
                inlinks[candidates[0]] += 1
            elif len(candidates) > 1:
                ambiguous.setdefault(s, set()).add(t)
            else:
                broken.setdefault(s, set()).add(t)

    orphans = [s for s, n in inlinks.items()
               if n == 0 and basename_slug(pages[s]) not in SPECIAL]

    # index coverage
    index_slugs = by_basename.get("index", [])
    index_path = pages.get(index_slugs[0]) if index_slugs else None
    in_index = set()
    if index_path:
        with open(index_path, encoding="utf-8") as fh:
            itext = fh.read()
        in_index = set(normalize_name(m.group(1)) for m in WIKILINK.finditer(itext))
    not_in_index = [s for s in pages
                    if basename_slug(pages[s]) not in SPECIAL
                    and basename_slug(pages[s]) not in in_index] if index_path else []
    index_dangling = [t for t in in_index if t not in by_basename]

    # ---- report ----
    def section(title, items, fmt):
        print(f"\n## {title} ({len(items)})")
        if not items:
            print("  none")
        for it in items:
            print("  - " + fmt(it))

    print(f"# wiki-lint report — {root} — {len(pages)} pages — {today}")
    section("Slug collisions (same filename in multiple folders)", sorted(collisions.items()),
            lambda kv: f"{kv[0]} -> {', '.join(kv[1])}")
    section("Orphan pages (no inbound links)", sorted(orphans), str)
    section("Broken wikilinks", sorted(broken.items()),
            lambda kv: f"{kv[0]} -> {', '.join(sorted(kv[1]))}")
    section("Ambiguous wikilinks (target name has multiple matching pages)", sorted(ambiguous.items()),
            lambda kv: f"{kv[0]} -> {', '.join(sorted(kv[1]))}")
    section("Missing frontmatter", sorted(no_frontmatter), str)
    section("Incomplete frontmatter", sorted(bad_frontmatter),
            lambda kv: f"{kv[0]} (missing: {', '.join(kv[1])})")
    section(f"Stale pages (>{STALE_DAYS}d since updated)", sorted(stale),
            lambda t: f"{t[0]} (updated {t[1]}, {t[2]}d ago)")
    section("Pages missing from index.md", sorted(not_in_index), str)
    section("index.md entries with no page", sorted(index_dangling), str)
    if not index_path:
        print("\n! no index.md found at wiki root")

    total = (len(collisions) + len(orphans) + len(broken) + len(ambiguous) +
             len(no_frontmatter) + len(bad_frontmatter) + len(stale) +
             len(not_in_index) + len(index_dangling))
    print(f"\n# total mechanical issues: {total}")


if __name__ == "__main__":
    main()
