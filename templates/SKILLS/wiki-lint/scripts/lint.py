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
    rel = os.path.relpath(path, root)
    return os.path.splitext(os.path.basename(rel))[0]


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

    pages = {}          # slug -> path
    outlinks = {}       # slug -> set(target slugs)
    inlinks = {}        # slug -> count
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
        pages[s] = path
        inlinks.setdefault(s, 0)
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        outlinks[s] = set(m.group(1).strip().lower().replace(" ", "-")
                          for m in WIKILINK.finditer(text))
        if s in SPECIAL:
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

    # resolve inbound links and broken links
    broken = {}
    for s, targets in outlinks.items():
        for t in targets:
            if t in pages:
                inlinks[t] = inlinks.get(t, 0) + 1
            else:
                broken.setdefault(s, set()).add(t)

    orphans = [s for s, n in inlinks.items()
               if n == 0 and s not in SPECIAL]

    # index coverage
    index_path = pages.get("index")
    in_index = set()
    if index_path:
        with open(index_path, encoding="utf-8") as fh:
            itext = fh.read()
        in_index = set(m.group(1).strip().lower().replace(" ", "-")
                       for m in WIKILINK.finditer(itext))
    not_in_index = [s for s in pages
                    if s not in SPECIAL and s not in in_index] if index_path else []
    index_dangling = [t for t in in_index if t not in pages]

    # ---- report ----
    def section(title, items, fmt):
        print(f"\n## {title} ({len(items)})")
        if not items:
            print("  none")
        for it in items:
            print("  - " + fmt(it))

    print(f"# wiki-lint report — {root} — {len(pages)} pages — {today}")
    section("Orphan pages (no inbound links)", sorted(orphans), str)
    section("Broken wikilinks", sorted(broken.items()),
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

    total = (len(orphans) + len(broken) + len(no_frontmatter) +
             len(bad_frontmatter) + len(stale) + len(not_in_index) +
             len(index_dangling))
    print(f"\n# total mechanical issues: {total}")


if __name__ == "__main__":
    main()
