#!/usr/bin/env python3
"""search.pyの単体テスト。実行方法: python3 -m unittest test_search -v"""
import importlib.util
import os
import sys
import tempfile
import time
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

    def run_search(self, query, limit=None):
        argv = sys.argv
        stdout = sys.stdout
        argv_list = ["search.py", query, self.root]
        if limit is not None:
            argv_list += ["-n", str(limit)]
        sys.argv = argv_list
        buf = StringIO()
        sys.stdout = buf
        try:
            search.main()
        finally:
            sys.argv = argv
            sys.stdout = stdout
        return buf.getvalue()

    def db_path(self):
        return os.path.join(self.root, search.INDEX_FILENAME)


class TestCjkBigramExpand(unittest.TestCase):
    def test_ascii_passthrough(self):
        self.assertEqual(search.cjk_bigram_expand("hello world"), "hello world")

    def test_cjk_run_becomes_bigrams(self):
        out = search.cjk_bigram_expand("東京都")
        self.assertIn("東京", out)
        self.assertIn("京都", out)

    def test_single_cjk_char(self):
        out = search.cjk_bigram_expand("日")
        self.assertEqual(out, "日")


class TestSanitizeQuery(unittest.TestCase):
    def test_simple_word(self):
        self.assertEqual(search.sanitize_query("agents"), '"agents"')

    def test_multiword_becomes_or(self):
        expr = search.sanitize_query("foo bar")
        self.assertIn("OR", expr)
        self.assertIn('"foo"', expr)
        self.assertIn('"bar"', expr)

    def test_double_quote_is_escaped(self):
        expr = search.sanitize_query('foo"bar')
        self.assertIn('""', expr)

    def test_fts5_special_chars_are_contained_in_phrase(self):
        # *や^などの特殊文字もフレーズ内に閉じ込められ、MATCH構文エラーを起こさない。
        expr = search.sanitize_query("foo*bar")
        self.assertTrue(expr.startswith('"') and expr.endswith('"'))

    def test_empty_query_returns_none(self):
        self.assertIsNone(search.sanitize_query("   "))


class TestNewIndexCreation(SearchTestCase):
    def test_creates_db_file(self):
        write(self.root, "a.md", "---\ntitle: A\n---\nhello world\n")
        self.run_search("hello")
        self.assertTrue(os.path.exists(self.db_path()))

    def test_no_matches(self):
        write(self.root, "a.md", "---\ntitle: A\n---\nnothing relevant here\n")
        out = self.run_search("zzzznomatch")
        self.assertIn("一致するページがありません", out)

    def test_ascii_query_finds_page(self):
        write(self.root, "entities/agents.md", "---\ntitle: Agents\n---\nAGENTS.md is the schema file.\n")
        out = self.run_search("agents")
        self.assertIn("entities/agents.md", out)

    def test_japanese_query_finds_page(self):
        """回帰テスト: unicode61はCJKを1トークンとして扱うため、
        バイグラム展開なしでは日本語クエリが一致しなかった。"""
        write(self.root, "sources/note.md", "---\ntitle: Note\n---\n日本語の情報を含むページです。\n")
        out = self.run_search("情報")
        self.assertIn("sources/note.md", out)

    def test_japanese_substring_match(self):
        """「東京都」を含む文に対して「東京」でも一致すること（バイグラム展開の効果）。"""
        write(self.root, "places/tokyo.md", "---\ntitle: Tokyo\n---\n東京都について書いたページです。\n")
        out = self.run_search("東京")
        self.assertIn("places/tokyo.md", out)


class TestRanking(SearchTestCase):
    def test_more_relevant_page_ranks_first(self):
        write(self.root, "a.md", "---\ntitle: Agents\n---\nagents\n")
        write(
            self.root,
            "b.md",
            "---\ntitle: Other\n---\nThis page briefly mentions agents once in passing text unrelated otherwise.\n",
        )
        out = self.run_search("agents")
        self.assertLess(out.index("a.md"), out.index("b.md"))


class TestReindexOnChange(SearchTestCase):
    def test_modified_file_is_reindexed(self):
        path = write(self.root, "a.md", "---\ntitle: A\n---\noriginal content\n")
        out = self.run_search("original")
        self.assertIn("a.md", out)

        # mtimeの分解能対策に少し待ってから更新する
        time.sleep(0.01)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("---\ntitle: A\n---\nupdated content about widgets\n")
        # ensure mtime actually changes even on coarse filesystems
        os.utime(path, (time.time() + 1, time.time() + 1))

        out_old_term = self.run_search("original")
        self.assertIn("一致するページがありません", out_old_term)

        out_new_term = self.run_search("widgets")
        self.assertIn("a.md", out_new_term)


class TestDeletionIsReflected(SearchTestCase):
    def test_deleted_file_is_removed_from_index(self):
        path = write(self.root, "a.md", "---\ntitle: A\n---\nuniqueterm here\n")
        out = self.run_search("uniqueterm")
        self.assertIn("a.md", out)

        os.remove(path)
        out = self.run_search("uniqueterm")
        self.assertIn("一致するページがありません", out)


class TestIncrementalSync(SearchTestCase):
    def test_unchanged_file_is_not_rewritten(self):
        write(self.root, "a.md", "---\ntitle: A\n---\nstable content\n")
        self.run_search("stable")

        conn = search.open_index(self.db_path())
        try:
            updated, removed = search.sync_index(conn, self.root)
        finally:
            conn.close()
        self.assertEqual(updated, 0)
        self.assertEqual(removed, 0)


if __name__ == "__main__":
    unittest.main()
