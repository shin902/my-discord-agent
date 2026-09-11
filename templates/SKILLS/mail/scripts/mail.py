#!/usr/bin/env python3
"""Thin subcommand frontend for Microsoft Graph mail capabilities."""
import argparse
import json
import subprocess
import sys


OPERATIONS = {"list": "list-emails", "read": "read-email"}


def invoke(capability, payload):
    try:
        result = subprocess.run(
            ["tool-proxy", capability, json.dumps(payload, ensure_ascii=False)],
            check=False,
        )
    except FileNotFoundError:
        print("tool-proxy is unavailable; update the Runner image", file=sys.stderr)
        return 1
    return result.returncode


def build_parser():
    parser = argparse.ArgumentParser(
        prog="mail.py",
        description="List and read Outlook mail through the shared Tool Proxy",
    )
    commands = parser.add_subparsers(dest="operation", required=True)

    list_parser = commands.add_parser("list", aliases=["emails"], help="list emails")
    list_parser.add_argument("--limit", type=int)
    list_parser.add_argument("--folder")
    list_parser.add_argument("--unread-only", action="store_true")

    read_parser = commands.add_parser("read", aliases=["email"], help="read one email")
    read_parser.add_argument("id")
    mark = read_parser.add_mutually_exclusive_group()
    mark.add_argument("--mark-as-read", dest="mark_as_read", action="store_true")
    mark.add_argument("--no-mark-as-read", dest="mark_as_read", action="store_false")
    read_parser.set_defaults(mark_as_read=None)

    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)

    if args.operation in ("list", "emails"):
        payload = {}
        if args.limit is not None:
            payload["limit"] = args.limit
        if args.folder is not None:
            payload["folder"] = args.folder
        if args.unread_only:
            payload["unreadOnly"] = True
        return invoke(OPERATIONS["list"], payload)

    payload = {"id": args.id}
    if args.mark_as_read is not None:
        payload["markAsRead"] = args.mark_as_read
    return invoke(OPERATIONS["read"], payload)


if __name__ == "__main__":
    raise SystemExit(main())
