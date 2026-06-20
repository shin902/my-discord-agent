#!/usr/bin/env python3
"""LLMが運用するwiki向けの、依存ライブラリ不要なキーワード検索。

使い方:
    python3 search.py "QUERY" [WIKI_DIR]      # WIKI_DIR省略時は ./wiki
"""
import os
import re
import sys

WORD = re.compile(r"[a-z0-9][a-z0-9'_-]*")
# ひらがな、カタカナ、CJK統合漢字、CJK互換漢字 — 単語間に空白を入れない言語。
# WORDのASCII限定文字クラスではこれらが落ちてqtermsが空になってしまうため、
# 文字バイグラムとして別途トークン化する。
CJK_RUN = re.compile(r"[぀-ヿ㐀-䶿一-鿿豈-﫿]+")
HEADING = re.compile(r"^#{1,6}\s|^title:|^tags:|^---", re.IGNORECASE)


def tokenize(text):
    text = text.lower()
    tokens = []
    pos = 0
    for m in CJK_RUN.finditer(text):
        tokens += WORD.findall(text[pos:m.start()])
        run = m.group(0)
        if len(run) == 1:
            tokens.append(run)
        else:
            tokens += [run[i:i + 2] for i in range(len(run) - 1)]
        pos = m.end()
    tokens += WORD.findall(text[pos:])
    return tokens


def main():
    if len(sys.argv) < 2:
        print('使い方: search.py "QUERY" [WIKI_DIR]', file=sys.stderr)
        sys.exit(1)
    query = sys.argv[1]
    root = sys.argv[2] if len(sys.argv) > 2 else "wiki"
    if not os.path.isdir(root):
        print(f"エラー: wikiディレクトリが見つかりません: {root}", file=sys.stderr)
        sys.exit(1)

    qterms = set(tokenize(query))
    if not qterms:
        print("エラー: クエリが空です", file=sys.stderr)
        sys.exit(1)

    git_dir = os.path.join(os.path.abspath(root), ".git")

    results = []
    for dirpath, _, files in os.walk(root):
        abs_dirpath = os.path.abspath(dirpath)
        if abs_dirpath == git_dir or abs_dirpath.startswith(git_dir + os.sep):
            continue
        for f in files:
            if not f.endswith(".md"):
                continue
            path = os.path.join(dirpath, f)
            with open(path, encoding="utf-8") as fh:
                lines = fh.readlines()
            text = "".join(lines)
            toks = tokenize(text)
            if not toks:
                continue
            score = 0.0
            hit_terms = set()
            for t in toks:
                if t in qterms:
                    score += 1.0
                    hit_terms.add(t)
            if not hit_terms:
                continue
            # 見出し/frontmatter/タイトル内のマッチにボーナスを付与
            for ln in lines[:40]:
                if HEADING.match(ln.strip()):
                    for t in tokenize(ln):
                        if t in qterms:
                            score += 2.0
            # カバレッジボーナス: より多くの異なるクエリ語にマッチしたものを優遇する
            score *= (1 + len(hit_terms) / len(qterms))
            # プレビュー用の最も良くマッチした行
            best = ""
            best_n = 0
            for ln in lines:
                n = sum(1 for t in tokenize(ln) if t in qterms)
                if n > best_n:
                    best_n, best = n, ln.strip()
            rel = os.path.relpath(path, root)
            results.append((score, rel, len(hit_terms), best[:140]))

    results.sort(reverse=True)
    if not results:
        print("一致するページがありません")
        return
    print(f"# {len(results)} 件のページが一致 — クエリ: {query!r}\n")
    for score, rel, nterms, preview in results[:15]:
        print(f"{score:6.1f}  {rel}  ({nterms}/{len(qterms)} 語)")
        if preview:
            print(f"        … {preview}")


if __name__ == "__main__":
    main()
