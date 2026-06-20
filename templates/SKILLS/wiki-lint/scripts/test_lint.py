#!/usr/bin/env python3
"""lint.pyの単体テスト。実行方法: python3 -m unittest test_lint -v"""
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
    """回帰テスト: entities/alice.md と concepts/alice.md が暗黙に
    1つのページへマージされてはならない（元のバグ — git履歴参照）。"""

    def test_same_basename_different_folders_both_kept(self):
        write(self.root, "entities/alice.md", page("Alice", body="entity version"))
        write(self.root, "concepts/alice.md", page("Alice", body="concept version"))
        write(self.root, "index.md", "# Index\n")

        out = self.run_lint()
        self.assertIn("スラッグの衝突", out)
        self.assertIn("alice -> concepts/alice, entities/alice", out)
        # both pages (+ index.md) must still be counted, not collapsed into one
        self.assertIn("3 ページ", out)

    def test_link_to_colliding_basename_reported_as_ambiguous(self):
        """フォルダ間で衝突するbasenameへのリンクは、候補のどれかへ暗黙に
        解決されることなく曖昧（ambiguous）として分類されなければならない。
        また、リンク切れとして報告されてもならない。"""
        write(self.root, "entities/alice.md", page("Alice", body="entity version"))
        write(self.root, "concepts/alice.md", page("Alice", body="concept version"))
        write(self.root, "entities/bob.md", page("Bob", body="friend of [[alice]]"))
        write(self.root, "index.md", "[[alice]]\n[[bob]]\n")

        out = self.run_lint()
        self.assertIn("曖昧なwikilink", out)
        ambiguous_block = _section(out, "曖昧なwikilink（ターゲット名が複数ページに一致）")
        self.assertIn("entities/bob -> alice", ambiguous_block)
        self.assertIn("index -> alice", ambiguous_block)
        self.assertNotIn("alice", _section(out, "リンク切れのwikilink"))


class TestWikilinkResolution(LintTestCase):
    def test_broken_link_reported(self):
        write(self.root, "entities/alice.md", page("Alice", body="see [[bob]]"))
        write(self.root, "index.md", "[[alice]]\n")

        out = self.run_lint()
        self.assertIn("リンク切れのwikilink", out)
        self.assertIn("entities/alice -> bob", out)

    def test_non_kebab_filename_still_resolves(self):
        """回帰テスト: wikilinkのテキストは小文字化 + スペース→ハイフン正規化を
        受ける。ファイル自身のbasenameも同じ正規化を経なければ、
        非kebab-caseのファイル名がリンク切れ/孤立に見えてしまう。"""
        write(self.root, "entities/Tokyo.md", page("Tokyo", body="capital"))
        write(self.root, "concepts/japan.md", page("Japan", body="see [[Tokyo]]"))
        write(self.root, "index.md", "[[tokyo]]\n[[japan]]\n")

        out = self.run_lint()
        self.assertNotIn("entities/Tokyo", _section(out, "リンク切れのwikilink"))
        self.assertNotIn("Tokyo", _section(out, "孤立ページ"))

    def test_valid_link_creates_no_issues(self):
        write(self.root, "entities/alice.md", page("Alice", body="friend of [[bob]]"))
        write(self.root, "entities/bob.md", page("Bob", body="friend of [[alice]]"))
        write(self.root, "index.md", "[[alice]]\n[[bob]]\n")

        out = self.run_lint()
        self.assertIn("リンク切れのwikilink (0)", out)
        self.assertIn("孤立ページ（インバウンドリンクなし） (0)", out)
        self.assertIn("機械的に検出された問題の総数: 0", out)

    def test_fullwidth_space_in_filename_still_resolves(self):
        """回帰テスト: 全角スペース（U+3000、日本語テキストで一般的）を含む
        ファイル名は、同じ全角スペースを使うwikilinkと同一のキーに
        正規化されなければならない。そうでないとリンク切れ/孤立として
        報告されてしまう。"""
        write(self.root, "entities/東京　都.md", page("Tokyo Metropolis", body="capital"))
        write(self.root, "concepts/japan.md", page("Japan", body="see [[東京　都]]"))
        write(self.root, "index.md", "[[東京　都]]\n[[japan]]\n")

        out = self.run_lint()
        self.assertNotIn("entities/東京", _section(out, "リンク切れのwikilink"))
        self.assertEqual([], _section_items(out, "孤立ページ（インバウンドリンクなし）"))
        self.assertEqual([], _section_items(out, "リンク切れのwikilink"))

    def test_underscore_filename_matches_hyphenated_link(self):
        """回帰テスト: アンダースコアはファイル名（my_page.md）でよく使われる
        単語区切りの表記揺れであり、ハイフン区切りやスペース区切りの
        wikilinkターゲット（[[my-page]] / [[my page]]）と同じに
        正規化されなければならない。"""
        write(self.root, "entities/my_page.md", page("My Page", body="content"))
        write(self.root, "concepts/linker.md", page("Linker", body="see [[my-page]]"))
        write(self.root, "index.md", "[[my page]]\n[[linker]]\n")

        out = self.run_lint()
        self.assertEqual([], _section_items(out, "リンク切れのwikilink"))
        self.assertEqual([], _section_items(out, "孤立ページ（インバウンドリンクなし）"))


class TestFrontmatter(LintTestCase):
    def test_missing_frontmatter_reported(self):
        write(self.root, "entities/alice.md", "just some text, no frontmatter\n")
        write(self.root, "index.md", "[[alice]]\n")

        out = self.run_lint()
        self.assertIn("frontmatterの欠落 (1)", out)
        self.assertIn("entities/alice", _section(out, "frontmatterの欠落"))

    def test_incomplete_frontmatter_reported(self):
        write(self.root, "entities/alice.md", "---\ntitle: Alice\n---\nbody\n")
        write(self.root, "index.md", "[[alice]]\n")

        out = self.run_lint()
        self.assertIn("frontmatterの不足 (1)", out)
        self.assertIn("不足: type, created, updated", _section(out, "frontmatterの不足"))


class TestStaleness(LintTestCase):
    def test_stale_page_flagged(self):
        old = (date.today() - timedelta(days=200)).isoformat()
        write(self.root, "entities/alice.md", page("Alice", updated=old))
        write(self.root, "index.md", "[[alice]]\n")

        out = self.run_lint()
        self.assertIn("古いページ", out)
        self.assertIn("entities/alice", _section(out, "古いページ"))

    def test_fresh_page_not_flagged(self):
        today = date.today().isoformat()
        write(self.root, "entities/alice.md", page("Alice", updated=today))
        write(self.root, "index.md", "[[alice]]\n")

        out = self.run_lint()
        self.assertEqual([], _section_items(out, "古いページ"))


class TestRootOnlySpecialPages(LintTestCase):
    """回帰テスト: index.md / log.md がwikiルートに直接置かれている場合のみ
    SPECIALとして扱われなければならない。サブディレクトリの同名ファイル
    （例: sources/index.md）は通常のページであり、「本物の」indexとして
    選ばれてはならず、frontmatter/orphanチェックから暗黙に除外されても
    ならない。"""

    def test_subdir_index_is_not_special(self):
        write(self.root, "index.md", "[[alice]]\n")
        write(self.root, "entities/alice.md", page("Alice"))
        write(self.root, "sources/index.md", page("Sources", body="not the real index"))

        out = self.run_lint()
        # サブディレクトリのindex.mdは通常のページ: frontmatterカバレッジが必要で、
        # 「missing from index.md」に出現するはず（誰もリンクせず、ルートindexにも
        # 載っていないため）、かつ孤立ページ（インバウンドリンクなし）として
        # 表示されなければならない。
        self.assertIn("sources/index", _section(out, "index.mdに記載のないページ"))
        self.assertIn("sources/index", _section(out, "孤立ページ"))
        # ルートのindex.mdと暗黙にマージされたり、SPECIALとして除外されてもならない。
        self.assertIn("3 ページ", out)

    def test_subdir_log_is_not_special(self):
        write(self.root, "index.md", "[[alice]]\n")
        write(self.root, "entities/alice.md", page("Alice"))
        write(self.root, "projects/log.md", page("Project Log", body="not the real log"))

        out = self.run_lint()
        self.assertIn("projects/log", _section(out, "index.mdに記載のないページ"))
        self.assertIn("projects/log", _section(out, "孤立ページ"))

    def test_root_index_used_for_index_coverage_even_with_subdir_index(self):
        """サブディレクトリのindex.mdに対するos.walkの走査順に関わらず、
        indexカバレッジの計算にはルートのindex.mdが使われなければならない。"""
        write(self.root, "index.md", "[[alice]]\n[[sources/index]]\n")
        write(self.root, "entities/alice.md", page("Alice"))
        write(self.root, "sources/index.md", page("Sources"))

        out = self.run_lint()
        # alice is linked from the real root index -> no longer "missing from index.md"
        self.assertNotIn("entities/alice", _section(out, "index.mdに記載のないページ"))

    def test_misplaced_special_reported(self):
        write(self.root, "index.md", "# Index\n")
        write(self.root, "sources/index.md", page("Sources"))
        write(self.root, "projects/log.md", page("Log"))

        out = self.run_lint()
        block = _section(out, "誤った位置のindex.md/log.md（wikiルート外、通常ページとして扱う）")
        self.assertIn("sources/index", block)
        self.assertIn("projects/log", block)

    def test_root_log_still_special(self):
        """サニティチェック: ルート直下のlog.mdは以前と同様にSPECIAL扱い
        （frontmatter/orphanチェック対象外）を維持する。"""
        write(self.root, "index.md", "[[alice]]\n")
        write(self.root, "entities/alice.md", page("Alice"))
        write(self.root, "log.md", "2026-06-19: did stuff\n")

        out = self.run_lint()
        self.assertNotIn("log", _section(out, "frontmatterの欠落"))
        self.assertNotIn("log", _section(out, "孤立ページ"))


class TestIndexCoverage(LintTestCase):
    def test_page_missing_from_index(self):
        write(self.root, "entities/alice.md", page("Alice"))
        write(self.root, "index.md", "# Index\n(nothing linked yet)\n")

        out = self.run_lint()
        self.assertIn("index.mdに記載のないページ (1)", out)
        self.assertIn("entities/alice", _section(out, "index.mdに記載のないページ"))

    def test_dangling_index_entry(self):
        write(self.root, "index.md", "[[ghost]]\n")

        out = self.run_lint()
        self.assertIn("index.mdに記載されているがページが存在しないエントリ (1)", out)
        self.assertIn("ghost", _section(out, "index.mdに記載されているがページが存在しないエントリ"))


def _section(out, title):
    """レポートの該当セクションの生テキストブロックを返す（次の'##'まで）。"""
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
