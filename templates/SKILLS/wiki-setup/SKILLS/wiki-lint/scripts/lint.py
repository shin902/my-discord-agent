#!/usr/bin/env python3
"""LLMが運用するwikiの読み取り専用ヘルスチェッカー。

機械的に検出できる問題のみを報告する — wikiを編集することは一切ない。
エージェントがこのレポートを読み、判断が必要なチェックを行い、
ユーザーの承認を得てから修正を適用する。

使い方:
    python3 lint.py [WIKI_DIR]      # WIKI_DIR省略時は ./wiki
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
    """ページの一意キー: 拡張子を除いた相対パス（例: 'entities/alice'）。"""
    rel = os.path.relpath(path, root)
    return os.path.splitext(rel)[0].replace(os.sep, "/")


def normalize_name(name):
    """[[wikilink]]のターゲットと同じ方法で名前を正規化し、
    ファイル名由来のキーとリンク由来のキーを比較可能にする。

    半角スペース、全角スペース（U+3000、日本語テキストで一般的）、
    アンダースコアといった表記揺れをすべてハイフンに変換して吸収する。
    例えば "my page"、"my_page"、"my　page"、"my-page" はすべて
    同じキーに正規化される。"""
    return (
        name.strip()
        .lower()
        .replace("　", "-")
        .replace(" ", "-")
        .replace("_", "-")
    )


def basename_slug(path):
    """[[wikilink]]が参照する裸の名前。例えば entities/alice.md と
    concepts/alice.md の両方に対して 'alice'。
    wikilinkのターゲットに合わせて正規化される（kebab-caseのファイル名は
    あくまで慣習であり保証ではない）。"""
    return normalize_name(os.path.splitext(os.path.basename(path))[0])


def is_root_special(path, root):
    """wikiルートに直接置かれた index.md / log.md の場合のみ True を返す。
    サブディレクトリ内の同名ファイル（例: sources/index.md）は通常の
    ページであり、wiki特有のindex/logではない — basenameだけでは
    両者を区別できないため、相対パスをチェックする。"""
    rel = os.path.relpath(path, root).replace(os.sep, "/")
    return rel in ("index.md", "log.md")


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
        print(f"エラー: wikiディレクトリが見つかりません: {root}", file=sys.stderr)
        sys.exit(1)

    pages = {}          # 一意スラッグ（拡張子なし相対パス） -> パス
    by_basename = {}    # 裸のwikilink名 -> それを共有する一意スラッグのリスト
    outlinks = {}       # 一意スラッグ -> set(ターゲットの裸の名前)
    inlinks = {}        # 一意スラッグ -> カウント
    no_frontmatter = []
    bad_frontmatter = []
    stale = []
    today = date.today()

    md_files = []
    for dirpath, _, files in os.walk(root):
        for f in files:
            if f.endswith(".md"):
                md_files.append(os.path.join(dirpath, f))

    special_slugs = set()      # ルート直下のindex.md / log.mdのスラッグ
    misplaced_special = []     # wikiルート以外で見つかったindex.md/log.md

    for path in md_files:
        s = slug(path, root)
        b = basename_slug(path)
        special = is_root_special(path, root)
        pages[s] = path
        by_basename.setdefault(b, []).append(s)
        inlinks.setdefault(s, 0)
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        outlinks[s] = set(normalize_name(m.group(1)) for m in WIKILINK.finditer(text))
        if special:
            special_slugs.add(s)
        elif b in ("index", "log"):
            misplaced_special.append(s)
        if special:
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

    # 複数のページに解決される裸の名前（例: entities/alice.md と concepts/alice.md）
    collisions = {b: sorted(slugs) for b, slugs in by_basename.items()
                  if len(slugs) > 1 and not (special_slugs & set(slugs))}

    # インバウンドリンク、リンク切れ、曖昧なリンク（wikilinkで参照されたcollision）を解決する
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
               if n == 0 and s not in special_slugs]

    # indexカバレッジ — basenameではなくspecial_slugsを使ってルートのindex.mdを
    # 一意に解決する（サブディレクトリのindex.mdを誤って取得してはならない）
    index_root_slugs = [s for s in special_slugs if basename_slug(pages[s]) == "index"]
    index_path = pages.get(index_root_slugs[0]) if index_root_slugs else None
    in_index = set()
    if index_path:
        with open(index_path, encoding="utf-8") as fh:
            itext = fh.read()
        in_index = set(normalize_name(m.group(1)) for m in WIKILINK.finditer(itext))
    not_in_index = [s for s in pages
                    if s not in special_slugs
                    and basename_slug(pages[s]) not in in_index] if index_path else []
    index_dangling = [t for t in in_index if t not in by_basename]

    # ---- レポート ----
    def section(title, items, fmt):
        print(f"\n## {title} ({len(items)})")
        if not items:
            print("  なし")
        for it in items:
            print("  - " + fmt(it))

    print(f"# wiki-lint レポート — {root} — {len(pages)} ページ — {today}")
    section("スラッグの衝突（同じファイル名が複数フォルダに存在）", sorted(collisions.items()),
            lambda kv: f"{kv[0]} -> {', '.join(kv[1])}")
    section("孤立ページ（インバウンドリンクなし）", sorted(orphans), str)
    section("リンク切れのwikilink", sorted(broken.items()),
            lambda kv: f"{kv[0]} -> {', '.join(sorted(kv[1]))}")
    section("曖昧なwikilink（ターゲット名が複数ページに一致）", sorted(ambiguous.items()),
            lambda kv: f"{kv[0]} -> {', '.join(sorted(kv[1]))}")
    section("frontmatterの欠落", sorted(no_frontmatter), str)
    section("frontmatterの不足", sorted(bad_frontmatter),
            lambda kv: f"{kv[0]} (不足: {', '.join(kv[1])})")
    section(f"古いページ（更新から{STALE_DAYS}日超）", sorted(stale),
            lambda t: f"{t[0]} (更新日 {t[1]}、{t[2]}日前)")
    section("index.mdに記載のないページ", sorted(not_in_index), str)
    section("index.mdに記載されているがページが存在しないエントリ", sorted(index_dangling), str)
    section("誤った位置のindex.md/log.md（wikiルート外、通常ページとして扱う）",
            sorted(misplaced_special), str)
    if not index_path:
        print("\n! wikiルートにindex.mdが見つかりません")

    total = (len(collisions) + len(orphans) + len(broken) + len(ambiguous) +
             len(no_frontmatter) + len(bad_frontmatter) + len(stale) +
             len(not_in_index) + len(index_dangling) + len(misplaced_special))
    print(f"\n# 機械的に検出された問題の総数: {total}")


if __name__ == "__main__":
    main()
