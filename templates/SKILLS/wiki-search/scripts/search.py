#!/usr/bin/env python3
"""Dependency-free keyword search over an LLM-maintained wiki.

Usage:
    python3 search.py "QUERY" [WIKI_DIR]      # WIKI_DIR defaults to ./wiki
"""
import os
import re
import sys

WORD = re.compile(r"[a-z0-9][a-z0-9'_-]*")
# Hiragana, katakana, CJK unified ideographs, and CJK compat — languages with
# no whitespace between words. Tokenized separately as character bigrams since
# WORD's ascii-only class would otherwise drop them and leave qterms empty.
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
        print('usage: search.py "QUERY" [WIKI_DIR]', file=sys.stderr)
        sys.exit(1)
    query = sys.argv[1]
    root = sys.argv[2] if len(sys.argv) > 2 else "wiki"
    if not os.path.isdir(root):
        print(f"error: wiki dir not found: {root}", file=sys.stderr)
        sys.exit(1)

    qterms = set(tokenize(query))
    if not qterms:
        print("error: empty query", file=sys.stderr)
        sys.exit(1)

    results = []
    for dirpath, _, files in os.walk(root):
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
            # bonus for matches in headings / frontmatter / title
            for ln in lines[:40]:
                if HEADING.match(ln.strip()):
                    for t in tokenize(ln):
                        if t in qterms:
                            score += 2.0
            # coverage bonus: reward hitting more distinct query terms
            score *= (1 + len(hit_terms) / len(qterms))
            # best matching line for preview
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
        print("no matches")
        return
    print(f"# {len(results)} pages match — query: {query!r}\n")
    for score, rel, nterms, preview in results[:15]:
        print(f"{score:6.1f}  {rel}  ({nterms}/{len(qterms)} terms)")
        if preview:
            print(f"        … {preview}")


if __name__ == "__main__":
    main()
