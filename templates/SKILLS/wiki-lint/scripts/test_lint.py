#!/usr/bin/env python3
"""Unit tests for lint.py. Run with: python3 -m unittest test_lint -v"""
import importlib.util
import os
import sys
import tempfile
import unittest
from datetime import date, timedelta

spec = importlib.util.spec_from_file_location(
    "lint", os.path.join(os.path.dirname(__file__), "lint.py")
)
lint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lint)


def write(root, rel_path, content):
    path = os.path.join(root, rel_path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)
    return path


def page(title, type_="entity", created=None, updated=None, body=""):
    today = date.today().isoformat()
    created = created or today
    updated = updated or today
    return (
        f"---\ntitle: {title}\ntype: {type_}\ncreated: {created}\n"
        f"updated: {updated}\ntags: []\n---\n\n{body}\n"
    )


class LintTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        self.addCleanup(self._tmp.cleanup)

    def run_lint(self):
        argv = sys.argv
        stdout = sys.stdout
        sys.argv = ["lint.py", self.root]
        from io import StringIO
        buf = StringIO()
        sys.stdout = buf
        try:
            lint.main()
        finally:
            sys.argv = argv
            sys.stdout = stdout
        return buf.getvalue()


class TestSlugCollision(LintTestCase):
    """Regression test: entities/alice.md and concepts/alice.md must not be
    silently merged into one page (the original bug — see git history)."""

    def test_same_basename_different_folders_both_kept(self):
        write(self.root, "entities/alice.md", page("Alice", body="entity version"))
        write(self.root, "concepts/alice.md", page("Alice", body="concept version"))
        write(self.root, "index.md", "# Index\n")

        out = self.run_lint()
        self.assertIn("Slug collisions", out)
        self.assertIn("alice -> concepts/alice, entities/alice", out)
        # both pages (+ index.md) must still be counted, not collapsed into one
        self.assertIn("3 pages", out)

    def test_link_to_colliding_basename_reported_as_ambiguous(self):
        """If a page links to a basename that collides across folders, the link
        must be classified as ambiguous — not silently resolved to one of the
        candidates, and not reported as broken either."""
        write(self.root, "entities/alice.md", page("Alice", body="entity version"))
        write(self.root, "concepts/alice.md", page("Alice", body="concept version"))
        write(self.root, "entities/bob.md", page("Bob", body="friend of [[alice]]"))
        write(self.root, "index.md", "[[alice]]\n[[bob]]\n")

        out = self.run_lint()
        self.assertIn("Ambiguous wikilinks", out)
        ambiguous_block = _section(out, "Ambiguous wikilinks (target name has multiple matching pages)")
        self.assertIn("entities/bob -> alice", ambiguous_block)
        self.assertIn("index -> alice", ambiguous_block)
        self.assertNotIn("alice", _section(out, "Broken wikilinks"))


class TestWikilinkResolution(LintTestCase):
    def test_broken_link_reported(self):
        write(self.root, "entities/alice.md", page("Alice", body="see [[bob]]"))
        write(self.root, "index.md", "[[alice]]\n")

        out = self.run_lint()
        self.assertIn("Broken wikilinks", out)
        self.assertIn("entities/alice -> bob", out)

    def test_non_kebab_filename_still_resolves(self):
        """Regression test: a wikilink's text gets lower-cased + space->hyphen
        normalized; the file's own basename must go through the same
        normalization or a non-kebab-case filename looks broken/orphaned."""
        write(self.root, "entities/Tokyo.md", page("Tokyo", body="capital"))
        write(self.root, "concepts/japan.md", page("Japan", body="see [[Tokyo]]"))
        write(self.root, "index.md", "[[tokyo]]\n[[japan]]\n")

        out = self.run_lint()
        self.assertNotIn("entities/Tokyo", _section(out, "Broken wikilinks"))
        self.assertNotIn("Tokyo", _section(out, "Orphan pages"))

    def test_valid_link_creates_no_issues(self):
        write(self.root, "entities/alice.md", page("Alice", body="friend of [[bob]]"))
        write(self.root, "entities/bob.md", page("Bob", body="friend of [[alice]]"))
        write(self.root, "index.md", "[[alice]]\n[[bob]]\n")

        out = self.run_lint()
        self.assertIn("Broken wikilinks (0)", out)
        self.assertIn("Orphan pages (no inbound links) (0)", out)
        self.assertIn("total mechanical issues: 0", out)

    def test_fullwidth_space_in_filename_still_resolves(self):
        """Regression test: a filename containing a full-width space (U+3000,
        common in Japanese text) must normalize to the same key as a wikilink
        using a full-width space, so it isn't reported broken/orphaned."""
        write(self.root, "entities/東京　都.md", page("Tokyo Metropolis", body="capital"))
        write(self.root, "concepts/japan.md", page("Japan", body="see [[東京　都]]"))
        write(self.root, "index.md", "[[東京　都]]\n[[japan]]\n")

        out = self.run_lint()
        self.assertNotIn("entities/東京", _section(out, "Broken wikilinks"))
        self.assertEqual([], _section_items(out, "Orphan pages (no inbound links)"))
        self.assertEqual([], _section_items(out, "Broken wikilinks"))

    def test_underscore_filename_matches_hyphenated_link(self):
        """Regression test: underscore is a common word-separator variant in
        filenames (my_page.md) and must normalize the same as a hyphenated or
        space-separated wikilink target ([[my-page]] / [[my page]])."""
        write(self.root, "entities/my_page.md", page("My Page", body="content"))
        write(self.root, "concepts/linker.md", page("Linker", body="see [[my-page]]"))
        write(self.root, "index.md", "[[my page]]\n[[linker]]\n")

        out = self.run_lint()
        self.assertEqual([], _section_items(out, "Broken wikilinks"))
        self.assertEqual([], _section_items(out, "Orphan pages (no inbound links)"))


class TestFrontmatter(LintTestCase):
    def test_missing_frontmatter_reported(self):
        write(self.root, "entities/alice.md", "just some text, no frontmatter\n")
        write(self.root, "index.md", "[[alice]]\n")

        out = self.run_lint()
        self.assertIn("Missing frontmatter (1)", out)
        self.assertIn("entities/alice", _section(out, "Missing frontmatter"))

    def test_incomplete_frontmatter_reported(self):
        write(self.root, "entities/alice.md", "---\ntitle: Alice\n---\nbody\n")
        write(self.root, "index.md", "[[alice]]\n")

        out = self.run_lint()
        self.assertIn("Incomplete frontmatter (1)", out)
        self.assertIn("missing: type, created, updated", _section(out, "Incomplete frontmatter"))


class TestStaleness(LintTestCase):
    def test_stale_page_flagged(self):
        old = (date.today() - timedelta(days=200)).isoformat()
        write(self.root, "entities/alice.md", page("Alice", updated=old))
        write(self.root, "index.md", "[[alice]]\n")

        out = self.run_lint()
        self.assertIn("Stale pages", out)
        self.assertIn("entities/alice", _section(out, "Stale pages"))

    def test_fresh_page_not_flagged(self):
        today = date.today().isoformat()
        write(self.root, "entities/alice.md", page("Alice", updated=today))
        write(self.root, "index.md", "[[alice]]\n")

        out = self.run_lint()
        self.assertEqual([], _section_items(out, "Stale pages"))


class TestIndexCoverage(LintTestCase):
    def test_page_missing_from_index(self):
        write(self.root, "entities/alice.md", page("Alice"))
        write(self.root, "index.md", "# Index\n(nothing linked yet)\n")

        out = self.run_lint()
        self.assertIn("Pages missing from index.md (1)", out)
        self.assertIn("entities/alice", _section(out, "Pages missing from index.md"))

    def test_dangling_index_entry(self):
        write(self.root, "index.md", "[[ghost]]\n")

        out = self.run_lint()
        self.assertIn("index.md entries with no page (1)", out)
        self.assertIn("ghost", _section(out, "index.md entries with no page"))


def _section(out, title):
    """Return the raw text block for a report section (until the next blank-line-prefixed '##')."""
    lines = out.splitlines()
    start = next((i for i, ln in enumerate(lines) if ln.startswith(f"## {title}")), None)
    if start is None:
        return ""
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("##")), len(lines))
    return "\n".join(lines[start:end])


def _section_items(out, title):
    block = _section(out, title)
    return [ln.strip()[2:] for ln in block.splitlines() if ln.strip().startswith("- ")]


if __name__ == "__main__":
    unittest.main()
