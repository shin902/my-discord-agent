#!/usr/bin/env python3
"""Unit tests for search.py. Run with: python3 -m unittest test_search -v"""
import importlib.util
import os
import sys
import tempfile
import unittest
from io import StringIO

spec = importlib.util.spec_from_file_location(
    "search", os.path.join(os.path.dirname(__file__), "search.py")
)
search = importlib.util.module_from_spec(spec)
spec.loader.exec_module(search)


def write(root, rel_path, content):
    path = os.path.join(root, rel_path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)
    return path


class SearchTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        self.addCleanup(self._tmp.cleanup)

    def run_search(self, query):
        argv = sys.argv
        stdout = sys.stdout
        sys.argv = ["search.py", query, self.root]
        buf = StringIO()
        sys.stdout = buf
        try:
            search.main()
        finally:
            sys.argv = argv
            sys.stdout = stdout
        return buf.getvalue()


class TestTokenize(unittest.TestCase):
    def test_ascii_tokenizes_as_words(self):
        self.assertEqual(search.tokenize("Hello World"), ["hello", "world"])

    def test_cjk_only_query_is_not_empty(self):
        """Regression test: an all-Japanese query used to produce zero tokens
        because WORD is ascii-only, causing 'error: empty query'."""
        toks = search.tokenize("情報")
        self.assertNotEqual(toks, [])

    def test_mixed_ascii_and_cjk(self):
        toks = search.tokenize("AGENTS 情報")
        self.assertIn("agents", toks)
        self.assertTrue(any("情" in t or "報" in t for t in toks))


class TestSearchCLI(SearchTestCase):
    def test_no_matches(self):
        write(self.root, "a.md", "---\ntitle: A\n---\nnothing relevant here\n")
        out = self.run_search("zzzznomatch")
        self.assertIn("no matches", out)

    def test_ascii_query_finds_page(self):
        write(self.root, "entities/agents.md", "---\ntitle: Agents\n---\nAGENTS.md is the schema file.\n")
        out = self.run_search("agents")
        self.assertIn("entities/agents.md", out)

    def test_japanese_only_query_does_not_error(self):
        """Regression test: previously exited 1 with 'error: empty query'."""
        write(self.root, "sources/note.md", "---\ntitle: Note\n---\n日本語の情報を含むページです。\n")
        out = self.run_search("情報")
        self.assertIn("sources/note.md", out)

    def test_multiword_query_ranks_more_coverage_higher(self):
        write(self.root, "a.md", "---\ntitle: A\n---\nfoo bar\n")
        write(self.root, "b.md", "---\ntitle: B\n---\nfoo only\n")
        out = self.run_search("foo bar")
        # the page hitting both terms should be listed before the one hitting only one
        self.assertLess(out.index("a.md"), out.index("b.md"))


if __name__ == "__main__":
    unittest.main()
