#!/usr/bin/env python3
"""次にやるべきタスクを推奨する。Python 3 標準ライブラリのみ。

usage:
  python3 next.py [tasks_dir]        # 着手可能なタスクを優先度順に推奨
  python3 next.py --all [tasks_dir]  # 全タスクをステータス別に一覧
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (  # noqa: E402
    PRIORITY_RANK,
    load_tasks,
    resolve_dir,
)


def main() -> None:
    tasks_dir = resolve_dir(sys.argv)
    show_all = "--all" in sys.argv
    if not os.path.isdir(tasks_dir):
        print(f"タスクディレクトリが見つかりません: {tasks_dir}")
        print("まだタスクが無い場合は task-add スキルで最初のタスクを作成してください。")
        return

    tasks = load_tasks(tasks_dir)
    if not tasks:
        print(f"タスクがありません: {tasks_dir}")
        return

    by_id = {t.id: t for t in tasks}
    done_ids = {t.id for t in tasks if t.status == "done"}

    def is_unblocked(t) -> bool:
        return all(dep in done_ids for dep in t.dependencies)

    if show_all:
        for status in ("in_progress", "pending", "blocked", "done"):
            group = [t for t in tasks if t.status == status]
            if not group:
                continue
            print(f"## {status} ({len(group)})")
            for t in sorted(group, key=lambda x: (PRIORITY_RANK.get(x.priority, 9), x.id)):
                dep = f"  deps:{t.dependencies}" if t.dependencies else ""
                print(f"  [{t.id}] {t.title}  <{t.priority}>{dep}")
            print()
        return

    # 推奨: pending かつ依存解決済み を優先度→id 順
    candidates = [t for t in tasks if t.status == "pending" and is_unblocked(t)]
    in_progress = [t for t in tasks if t.status == "in_progress"]

    if in_progress:
        print("## 進行中（先に片付ける）")
        for t in in_progress:
            print(f"  [{t.id}] {t.title}")
        print()

    if not candidates:
        blocked = [t for t in tasks if t.status == "pending" and not is_unblocked(t)]
        if blocked:
            print("着手可能な pending タスクがありません。依存待ちのタスク:")
            for t in blocked:
                pending_deps = [d for d in t.dependencies if d not in done_ids]
                print(f"  [{t.id}] {t.title}  ← 待ち: {pending_deps}")
        else:
            print("着手可能なタスクがありません。")
        return

    print("## 次の候補（優先度順・依存解決済み）")
    for i, t in enumerate(
        sorted(candidates, key=lambda x: (PRIORITY_RANK.get(x.priority, 9), x.id)), 1
    ):
        files = f"  files:{t.files}" if t.files else ""
        print(f"  {i}. [{t.id}] {t.title}  <{t.priority}/{t.effort or '?'}>{files}")


if __name__ == "__main__":
    main()
