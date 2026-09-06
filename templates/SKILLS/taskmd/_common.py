"""taskmd 共有ユーティリティ。Python 3 標準ライブラリのみ（ゼロ依存）。

PyYAML に依存しないよう、frontmatter で実際に使う型（文字列・YAMLフローの配列）だけを
手書きでパースする最小実装。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

DEFAULT_TASKS_DIR = "/workspace/tasks"

STATUS_VALUES = {"pending", "in_progress", "blocked", "done"}
PRIORITY_VALUES = {"high", "medium", "low"}
PRIORITY_RANK = {"high": 0, "medium": 1, "low": 2}
EFFORT_VALUES = {"small", "medium", "large"}


@dataclass
class Task:
    id: str
    title: str
    status: str
    priority: str
    effort: str = ""
    type: str = ""
    dependencies: list[str] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    created: str = ""
    path: str = ""
    raw: dict = field(default_factory=dict)


def _strip_quotes(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        return s[1:-1]
    return s


def _parse_list(s: str) -> list[str]:
    s = s.strip()
    if not s or s in ("[]", "~", "null"):
        return []
    if s.startswith("[") and s.endswith("]"):
        inner = s[1:-1].strip()
        if not inner:
            return []
        return [_strip_quotes(x) for x in inner.split(",") if x.strip()]
    return [_strip_quotes(x) for x in s.split(",") if x.strip()]


def _parse_frontmatter(text: str) -> tuple[dict, str]:
    """先頭の --- ... --- ブロックを dict に。戻り値は (frontmatter, body)。"""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text
    fm: dict = {}
    i = 1
    while i < len(lines) and lines[i].strip() != "---":
        line = lines[i]
        i += 1
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        val = val.strip()
        if val.startswith("[") or (key in ("dependencies", "files", "tags")):
            fm[key] = _parse_list(val)
        else:
            fm[key] = _strip_quotes(val)
    body = "\n".join(lines[i + 1:]) if i < len(lines) else ""
    return fm, body


def _as_list(v) -> list[str]:
    if isinstance(v, list):
        return [str(x) for x in v]
    if v in (None, ""):
        return []
    return [str(v)]


def load_task(path: str) -> Task:
    with open(path, encoding="utf-8") as f:
        fm, _ = _parse_frontmatter(f.read())
    return Task(
        id=str(fm.get("id", "")),
        title=str(fm.get("title", "")),
        status=str(fm.get("status", "")),
        priority=str(fm.get("priority", "")),
        effort=str(fm.get("effort", "")),
        type=str(fm.get("type", "")),
        dependencies=_as_list(fm.get("dependencies")),
        files=_as_list(fm.get("files")),
        tags=_as_list(fm.get("tags")),
        created=str(fm.get("created", "")),
        path=path,
        raw=fm,
    )


def load_tasks(tasks_dir: str) -> list[Task]:
    tasks: list[Task] = []
    for root, _dirs, files in os.walk(tasks_dir):
        for name in files:
            if name.endswith(".md") and not name.startswith("_"):
                tasks.append(load_task(os.path.join(root, name)))
    tasks.sort(key=lambda t: t.id)
    return tasks


def resolve_dir(argv: list[str]) -> str:
    for a in argv[1:]:
        if not a.startswith("-"):
            return a
    return DEFAULT_TASKS_DIR
