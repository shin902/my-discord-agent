#!/usr/bin/env python3
"""LLMが運用する大規模wiki向けの、SQLite FTS5によるBM25全文検索。

標準ライブラリのみを使用する（外部パッケージ不要）。WIKI_DIR直下に
インデックスDBファイル（.wiki-search-fts.sqlite3）を永続化し、
ファイルのmtime/サイズが変化したページだけを再インデックスする
（毎回フルスキャンしない差分インデックス。削除されたファイルも検知して
テーブルから取り除く）。

使い方:
    python3 search.py "QUERY" [WIKI_DIR]      # WIKI_DIR省略時は ./wiki

注意（日本語トークナイズについて）:
    FTS5の `unicode61` トークナイザは空白・記号で分割する単純な実装で、
    日本語のような分かち書きしない言語では文全体が1トークンになってしまい
    検索が機能しない（形態素解析は行わない）。これを回避するため、
    インデックス登録前にCJK文字の連続部分を文字バイグラム（2文字ずつの
    重複ウィンドウ）に展開してから渡している。これにより「東京都」を
    含む文に対して「東京」や「京都」でも部分一致できるようになるが、
    厳密な形態素解析ほどの精度はない点に注意。
"""
import argparse
import os
import re
import sqlite3
import sys

INDEX_FILENAME = ".wiki-search-fts.sqlite3"

FRONTMATTER_TITLE = re.compile(r"^title:\s*(.+)$", re.IGNORECASE | re.MULTILINE)
HEADING = re.compile(r"^#{1,6}\s+(.+)$", re.MULTILINE)
FRONTMATTER_BLOCK = re.compile(r"^---\n.*?\n---\n", re.DOTALL)

# ひらがな、カタカナ、CJK統合漢字、CJK互換漢字 — 単語間に空白を入れない言語。
CJK_RUN = re.compile(r"[぀-ヿ㐀-䶿一-鿿豈-﫿]+")


def cjk_bigram_expand(text):
    """CJK文字の連続部分を文字バイグラムへ展開する（unicode61対策）。

    FTS5のunicode61トークナイザはCJKを空白なしの1トークンとして扱って
    しまうため、インデックス・クエリの両方でこの前処理を通すことで
    部分一致を可能にする。ASCII部分はそのまま素通りする。
    """
    out = []
    pos = 0
    for m in CJK_RUN.finditer(text):
        out.append(text[pos:m.start()])
        run = m.group(0)
        if len(run) == 1:
            out.append(run)
        else:
            out.append(" ".join(run[i:i + 2] for i in range(len(run) - 1)))
        pos = m.end()
    out.append(text[pos:])
    return "".join(out)


def extract_title(text, fallback):
    """frontmatterのtitleか、なければ最初の見出しをタイトルとして使う。"""
    m = FRONTMATTER_TITLE.search(text)
    if m:
        return m.group(1).strip()
    m = HEADING.search(text)
    if m:
        return m.group(1).strip()
    return fallback


def strip_frontmatter(text):
    """先頭のYAML frontmatterブロックを除いた本文を返す（抜粋表示用）。"""
    return FRONTMATTER_BLOCK.sub("", text, count=1)


def file_signature(path):
    """変更検知用の署名（mtime + サイズ）。中身のハッシュより安価。"""
    st = os.stat(path)
    return f"{st.st_mtime_ns}:{st.st_size}"


def open_index(db_path):
    """インデックスDBを開き、必要ならFTS5テーブルを作成する。

    body列には検索用にCJKバイグラム展開済みのテキストを、raw_body列には
    抜粋表示用の元テキスト（frontmatter除去済み）を保持する。
    """
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS pages USING fts5(
            path,
            title,
            body,
            raw_body UNINDEXED,
            tokenize = 'porter unicode61'
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS pages_meta (
            path TEXT PRIMARY KEY,
            signature TEXT NOT NULL
        )
        """
    )
    conn.commit()
    return conn


def sync_index(conn, root):
    """wiki内の.mdファイルとインデックスの差分を同期する。

    - 新規/変更ファイル: DELETE + INSERT で再インデックス（FTS5は直接UPDATE不可）
    - 削除されたファイル: テーブルから削除
    戻り値: (追加・更新件数, 削除件数)
    """
    git_dir = os.path.join(os.path.abspath(root), ".git")
    seen = {}
    for dirpath, _, files in os.walk(root):
        abs_dirpath = os.path.abspath(dirpath)
        if abs_dirpath == git_dir or abs_dirpath.startswith(git_dir + os.sep):
            continue
        for f in files:
            if not f.endswith(".md"):
                continue
            path = os.path.join(dirpath, f)
            rel = os.path.relpath(path, root)
            seen[rel] = file_signature(path)

    cur = conn.execute("SELECT path, signature FROM pages_meta")
    known = dict(cur.fetchall())

    updated = 0
    for rel, sig in seen.items():
        if known.get(rel) == sig:
            continue
        abs_path = os.path.join(root, rel)
        try:
            with open(abs_path, encoding="utf-8") as fh:
                text = fh.read()
        except OSError:
            continue
        title = extract_title(text, fallback=rel)
        raw_body = strip_frontmatter(text)
        indexed_body = cjk_bigram_expand(text)
        conn.execute("DELETE FROM pages WHERE path = ?", (rel,))
        conn.execute(
            "INSERT INTO pages (path, title, body, raw_body) VALUES (?, ?, ?, ?)",
            (rel, title, indexed_body, raw_body),
        )
        conn.execute(
            "INSERT OR REPLACE INTO pages_meta (path, signature) VALUES (?, ?)",
            (rel, sig),
        )
        updated += 1

    removed = 0
    for rel in known:
        if rel not in seen:
            conn.execute("DELETE FROM pages WHERE path = ?", (rel,))
            conn.execute("DELETE FROM pages_meta WHERE path = ?", (rel,))
            removed += 1

    conn.commit()
    return updated, removed


def sanitize_query(query):
    """FTS5のMATCH構文向けにクエリをサニタイズする。

    ユーザー入力をそのままMATCH式に渡すとFTS5の構文（"*^などの予約文字や
    AND/OR/NOTなどの演算子トークン）として解釈されてしまうことがあるため、
    単語ごとに二重引用符で囲んだフレーズトークンにしてOR検索として
    結合する。CJK部分はインデックス時と同じバイグラム展開を通してから
    フレーズ化する。SQL文自体は常にパラメータバインディングで渡すため、
    SQLインジェクションの余地はない。
    """
    words = [w for w in re.split(r"\s+", query.strip()) if w]
    if not words:
        return None
    escaped = []
    for w in words:
        expanded = cjk_bigram_expand(w)
        # 二重引用符はFTS5フレーズ内で""にエスケープする。
        expanded = expanded.replace('"', '""')
        escaped.append(f'"{expanded}"')
    return " OR ".join(escaped)


def best_excerpt(raw_body, words, width=140):
    """クエリ語を最も多く含む行を抜粋として返す。なければ先頭の非空行。"""
    lines = [ln.strip() for ln in raw_body.splitlines() if ln.strip()]
    if not lines:
        return ""
    lowered_words = [w.lower() for w in words]
    best_line = lines[0]
    best_hits = -1
    for ln in lines:
        low = ln.lower()
        hits = sum(1 for w in lowered_words if w in low)
        if hits > best_hits:
            best_hits, best_line = hits, ln
    return best_line[:width]


def main():
    parser = argparse.ArgumentParser(
        description="SQLite FTS5を使ったwikiのBM25全文検索（標準ライブラリのみ）"
    )
    parser.add_argument("query", help="検索クエリ")
    parser.add_argument("wiki_dir", nargs="?", default="wiki", help="wikiディレクトリ（既定: ./wiki）")
    parser.add_argument("-n", "--limit", type=int, default=15, help="表示する最大件数（既定: 15）")
    args = parser.parse_args()

    root = args.wiki_dir
    if not os.path.isdir(root):
        print(f"エラー: wikiディレクトリが見つかりません: {root}", file=sys.stderr)
        sys.exit(1)

    match_expr = sanitize_query(args.query)
    if not match_expr:
        print("エラー: クエリが空です", file=sys.stderr)
        sys.exit(1)

    db_path = os.path.join(root, INDEX_FILENAME)
    conn = open_index(db_path)
    try:
        sync_index(conn, root)

        cur = conn.execute(
            """
            SELECT path, title, raw_body, bm25(pages, 0.0, 5.0, 1.0) AS score
            FROM pages
            WHERE pages MATCH ?
            ORDER BY score
            LIMIT ?
            """,
            (match_expr, args.limit),
        )
        rows = cur.fetchall()
    finally:
        conn.close()

    if not rows:
        print("一致するページがありません")
        return

    words = [w for w in re.split(r"\s+", args.query.strip()) if w]
    print(f"# {len(rows)} 件のページが一致 — クエリ: {args.query!r}\n")
    for path, title, raw_body, score in rows:
        # bm25()はSQLiteでは小さい(より負の)値ほど関連度が高い。表示用に符号を反転する。
        # 生の値は絶対値が小さいことが多いため、桁を見やすくするために1000倍して表示する
        # （ランキングの相対順序にのみ意味があり、絶対値そのものに意味はない）。
        print(f"{-score * 1000:8.3f}  {path}  ({title})")
        excerpt = best_excerpt(raw_body, words)
        if excerpt:
            print(f"        … {excerpt}")


if __name__ == "__main__":
    main()
