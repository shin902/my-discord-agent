#!/usr/bin/env python3
"""タスクファイルの frontmatter とスキーマを検証する。Python 3 標準ライブラリのみ。

usage:
  python3 validate.py [tasks_dir]

エラーがあれば exit code 1。
"""

from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (  # noqa: E402
    EFFORT_VALUES,
    PRIORITY_VALUES,
    STATUS_VALUES,
    load_tasks,
    resolve_dir,
)

ID_RE = re.compile(r"^\d{3,}$")


def main() -> None:
    tasks_dir = resolve_dir(sys.argv)
    if not os.path.isdir(tasks_dir):
        print(f"タスクディレクトリが見つかりません: {tasks_dir}")
        sys.exit(1)

    tasks = load_tasks(tasks_dir)
    errors: list[str] = []
    warnings: list[str] = []
    seen_ids: dict[str, str] = {}

    for t in tasks:
        name = os.path.basename(t.path)
        # 必須フィールド
        if not t.id:
            errors.append(f"{name}: id がありません")
        elif not ID_RE.match(t.id):
            warnings.append(f"{name}: id '{t.id}' はゼロ埋め数字を推奨")
        if not t.title:
            errors.append(f"{name}: title がありません")
        if t.status not in STATUS_VALUES:
            errors.append(f"{name}: status '{t.status}' は不正（{sorted(STATUS_VALUES)}）")
        if t.priority not in PRIORITY_VALUES:
            errors.append(f"{name}: priority '{t.priority}' は不正（{sorted(PRIORITY_VALUES)}）")
        if t.effort and t.effort not in EFFORT_VALUES:
            warnings.append(f"{name}: effort '{t.effort}' は非標準")
        # id 重複
        if t.id and t.id in seen_ids:
            errors.append(f"{name}: id '{t.id}' が {seen_ids[t.id]} と重複")
        elif t.id:
            seen_ids[t.id] = name
        # ファイル名と id の整合
        if t.id and not name.startswith(f"{t.id}-"):
            warnings.append(f"{name}: ファイル名が id '{t.id}-' で始まっていません")

    all_ids = {t.id for t in tasks if t.id}
    for t in tasks:
        name = os.path.basename(t.path)
        for dep in t.dependencies:
            if dep not in all_ids:
                errors.append(f"{name}: 依存先 '{dep}' が存在しません")

    # 循環依存の検出
    graph = {t.id: [d for d in t.dependencies if d in all_ids] for t in tasks if t.id}
    cycle = _find_cycle(graph)
    if cycle:
        errors.append(f"循環依存を検出: {' -> '.join(cycle)}")

    for w in warnings:
        print(f"WARN  {w}")
    for e in errors:
        print(f"ERROR {e}")

    n = len(tasks)
    if errors:
        print(f"\n{n} タスク中 {len(errors)} 件のエラー、{len(warnings)} 件の警告")
        sys.exit(1)
    print(f"\nOK: {n} タスク、エラーなし（警告 {len(warnings)} 件）")


def _find_cycle(graph: dict[str, list[str]]) -> list[str]:
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {n: WHITE for n in graph}
    stack: list[str] = []

    def dfs(node: str) -> list[str]:
        color[node] = GRAY
        stack.append(node)
        for nxt in graph.get(node, []):
            if color.get(nxt) == GRAY:
                idx = stack.index(nxt)
                return stack[idx:] + [nxt]
            if color.get(nxt) == WHITE:
                r = dfs(nxt)
                if r:
                    return r
        stack.pop()
        color[node] = BLACK
        return []

    for n in graph:
        if color[n] == WHITE:
            r = dfs(n)
            if r:
                return r
    return []


if __name__ == "__main__":
    main()
