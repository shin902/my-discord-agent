#!/usr/bin/env python3
import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

STATUSES = ("inbox", "reviewed", "keep", "try", "done", "ignore")
DEFAULT_DB = os.environ.get("X_SAVED_DB_PATH", "/x-saved/x-saved.sqlite")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def fail(message: str, code: int = 2) -> None:
    print(json.dumps({"error": message}, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(code)


def connect(db_path: str) -> sqlite3.Connection:
    path = Path(db_path)
    if not path.is_file():
        fail(
            f"x-saved database not found: {path}. "
            "Mount data/x-saved to /x-saved or pass --db."
        )
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def decode_json(value: Any, fallback: Any) -> Any:
    if not isinstance(value, str):
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


def row_to_item(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    if "external_urls_json" in item:
        item["external_urls"] = decode_json(item.pop("external_urls_json"), [])
    if "tags_json" in item:
        item["tags"] = decode_json(item.pop("tags_json"), [])
    for key in ("seen_liked", "seen_bookmarked", "baseline"):
        if key in item:
            item[key] = bool(item[key])
    return item


def item_select() -> str:
    return """
        SELECT
          i.tweet_id,
          i.text,
          i.author_handle,
          i.url,
          i.tweet_created_at,
          i.external_urls_json,
          i.seen_liked,
          i.seen_bookmarked,
          i.baseline,
          i.first_seen_at,
          i.last_seen_at,
          s.status,
          s.priority,
          s.summary,
          s.note,
          s.processed_at,
          s.updated_at,
          COALESCE((
            SELECT json_group_array(tag)
            FROM (
              SELECT tag FROM x_tags t
              WHERE t.tweet_id = i.tweet_id
              ORDER BY tag
            )
          ), '[]') AS tags_json
        FROM x_items i
        JOIN x_item_state s ON s.tweet_id = i.tweet_id
    """


def collection_clause(collection: str) -> str:
    if collection == "bookmarks":
        return "i.seen_bookmarked = 1"
    if collection == "likes":
        return "i.seen_liked = 1"
    return "1 = 1"


def cmd_status(conn: sqlite3.Connection, _args: argparse.Namespace) -> None:
    total = conn.execute("SELECT COUNT(*) AS n FROM x_items").fetchone()["n"]
    baseline = conn.execute(
        "SELECT COUNT(*) AS n FROM x_items WHERE baseline = 1"
    ).fetchone()["n"]
    actionable = conn.execute(
        """
        SELECT COUNT(*) AS n
        FROM x_items i
        JOIN x_item_state s ON s.tweet_id = i.tweet_id
        WHERE i.baseline = 0 AND s.status = 'inbox'
        """
    ).fetchone()["n"]
    states = {
        row["status"]: row["n"]
        for row in conn.execute(
            "SELECT status, COUNT(*) AS n FROM x_item_state GROUP BY status"
        ).fetchall()
    }
    collections = conn.execute(
        """
        SELECT
          SUM(CASE WHEN seen_bookmarked = 1 THEN 1 ELSE 0 END) AS bookmarks,
          SUM(CASE WHEN seen_liked = 1 THEN 1 ELSE 0 END) AS likes
        FROM x_items
        """
    ).fetchone()
    latest = conn.execute(
        """
        SELECT id, started_at, completed_at, status, bookmarks_fetched,
               likes_fetched, new_items, updated_items, error
        FROM x_sync_runs
        ORDER BY id DESC
        LIMIT 1
        """
    ).fetchone()
    print(
        json.dumps(
            {
                "total": total,
                "baseline": baseline,
                "pending": actionable,
                "states": states,
                "collections": dict(collections) if collections else {},
                "last_sync": dict(latest) if latest else None,
            },
            ensure_ascii=False,
        )
    )


def cmd_recent(conn: sqlite3.Connection, args: argparse.Namespace) -> None:
    where = [collection_clause(args.collection)]
    params: list[Any] = []
    if args.status:
        where.append("s.status = ?")
        params.append(args.status)
    if not args.include_baseline:
        where.append("i.baseline = 0")
    params.append(args.limit)
    rows = conn.execute(
        f"""
        {item_select()}
        WHERE {' AND '.join(where)}
        ORDER BY i.first_seen_at DESC, i.tweet_id DESC
        LIMIT ?
        """,
        params,
    ).fetchall()
    print(json.dumps({"items": [row_to_item(row) for row in rows]}, ensure_ascii=False))


def cmd_pending(conn: sqlite3.Connection, args: argparse.Namespace) -> None:
    where = ["s.status = 'inbox'"]
    if not args.include_baseline:
        where.append("i.baseline = 0")
    rows = conn.execute(
        f"""
        {item_select()}
        WHERE {' AND '.join(where)}
        ORDER BY i.first_seen_at ASC, i.tweet_id ASC
        LIMIT ?
        """,
        (args.limit,),
    ).fetchall()
    print(json.dumps({"items": [row_to_item(row) for row in rows]}, ensure_ascii=False))


def cmd_search(conn: sqlite3.Connection, args: argparse.Namespace) -> None:
    pattern = f"%{args.query}%"
    where = [
        """(
          i.text LIKE ? COLLATE NOCASE
          OR i.author_handle LIKE ? COLLATE NOCASE
          OR COALESCE(s.summary, '') LIKE ? COLLATE NOCASE
          OR COALESCE(s.note, '') LIKE ? COLLATE NOCASE
          OR EXISTS (
            SELECT 1 FROM x_tags t
            WHERE t.tweet_id = i.tweet_id
              AND t.tag LIKE ? COLLATE NOCASE
          )
        )""",
        collection_clause(args.collection),
    ]
    params: list[Any] = [pattern, pattern, pattern, pattern, pattern]
    if args.status:
        where.append("s.status = ?")
        params.append(args.status)
    params.append(args.limit)
    rows = conn.execute(
        f"""
        {item_select()}
        WHERE {' AND '.join(where)}
        ORDER BY COALESCE(s.priority, 0) DESC, i.last_seen_at DESC
        LIMIT ?
        """,
        params,
    ).fetchall()
    print(json.dumps({"items": [row_to_item(row) for row in rows]}, ensure_ascii=False))


def cmd_show(conn: sqlite3.Connection, args: argparse.Namespace) -> None:
    row = conn.execute(
        f"""
        {item_select()}
        WHERE i.tweet_id = ?
        LIMIT 1
        """,
        (args.tweet_id,),
    ).fetchone()
    if not row:
        fail(f"tweet not found: {args.tweet_id}", 1)
    print(json.dumps(row_to_item(row), ensure_ascii=False))


def require_item(conn: sqlite3.Connection, tweet_id: str) -> None:
    row = conn.execute(
        "SELECT 1 FROM x_items WHERE tweet_id = ?", (tweet_id,)
    ).fetchone()
    if not row:
        fail(f"tweet not found: {tweet_id}", 1)


def cmd_mark(conn: sqlite3.Connection, args: argparse.Namespace) -> None:
    require_item(conn, args.tweet_id)
    timestamp = now_iso()
    processed_at = None if args.status == "inbox" else timestamp
    conn.execute(
        """
        UPDATE x_item_state
        SET status = ?,
            priority = COALESCE(?, priority),
            summary = COALESCE(?, summary),
            processed_at = CASE
              WHEN ? IS NULL THEN NULL
              ELSE COALESCE(processed_at, ?)
            END,
            updated_at = ?
        WHERE tweet_id = ?
        """,
        (
            args.status,
            args.priority,
            args.summary,
            processed_at,
            processed_at,
            timestamp,
            args.tweet_id,
        ),
    )
    conn.commit()
    print(
        json.dumps(
            {
                "tweet_id": args.tweet_id,
                "status": args.status,
                "priority": args.priority,
                "summary": args.summary,
                "updated_at": timestamp,
            },
            ensure_ascii=False,
        )
    )


def cmd_tag(conn: sqlite3.Connection, args: argparse.Namespace) -> None:
    require_item(conn, args.tweet_id)
    tag = args.tag.strip()
    if not tag:
        fail("tag must not be empty")
    conn.execute(
        "INSERT OR IGNORE INTO x_tags (tweet_id, tag) VALUES (?, ?)",
        (args.tweet_id, tag),
    )
    conn.commit()
    print(json.dumps({"tweet_id": args.tweet_id, "tag": tag}, ensure_ascii=False))


def cmd_note(conn: sqlite3.Connection, args: argparse.Namespace) -> None:
    require_item(conn, args.tweet_id)
    timestamp = now_iso()
    conn.execute(
        "UPDATE x_item_state SET note = ?, updated_at = ? WHERE tweet_id = ?",
        (args.note, timestamp, args.tweet_id),
    )
    conn.commit()
    print(
        json.dumps(
            {"tweet_id": args.tweet_id, "note": args.note, "updated_at": timestamp},
            ensure_ascii=False,
        )
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read and manage the x-saved database")
    parser.add_argument("--db", default=DEFAULT_DB, help="x-saved SQLite path")
    sub = parser.add_subparsers(dest="command", required=True)

    status = sub.add_parser("status")
    status.set_defaults(func=cmd_status)

    recent = sub.add_parser("recent")
    recent.add_argument(
        "--collection", choices=("all", "bookmarks", "likes"), default="all"
    )
    recent.add_argument("--status", choices=STATUSES)
    recent.add_argument("--include-baseline", action="store_true")
    recent.add_argument("--limit", type=int, default=20)
    recent.set_defaults(func=cmd_recent)

    pending = sub.add_parser("pending")
    pending.add_argument("--include-baseline", action="store_true")
    pending.add_argument("--limit", type=int, default=20)
    pending.set_defaults(func=cmd_pending)

    search = sub.add_parser("search")
    search.add_argument("query")
    search.add_argument(
        "--collection", choices=("all", "bookmarks", "likes"), default="all"
    )
    search.add_argument("--status", choices=STATUSES)
    search.add_argument("--limit", type=int, default=20)
    search.set_defaults(func=cmd_search)

    show = sub.add_parser("show")
    show.add_argument("tweet_id")
    show.set_defaults(func=cmd_show)

    mark = sub.add_parser("mark")
    mark.add_argument("tweet_id")
    mark.add_argument("status", choices=STATUSES)
    mark.add_argument("--priority", type=int, choices=range(0, 101), metavar="0-100")
    mark.add_argument("--summary")
    mark.set_defaults(func=cmd_mark)

    tag = sub.add_parser("tag")
    tag.add_argument("tweet_id")
    tag.add_argument("tag")
    tag.set_defaults(func=cmd_tag)

    note = sub.add_parser("note")
    note.add_argument("tweet_id")
    note.add_argument("note")
    note.set_defaults(func=cmd_note)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    if hasattr(args, "limit") and args.limit < 1:
        fail("--limit must be positive")
    conn = connect(args.db)
    try:
        args.func(conn, args)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
