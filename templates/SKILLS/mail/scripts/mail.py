#!/usr/bin/env python3
"""Thin subcommand frontend for Microsoft Graph mail capabilities."""
import argparse
import json
import os
import sys


def build_parser():
    parser = argparse.ArgumentParser(
        prog="mail.py", description="Read Outlook mail through Tool Proxy"
    )
    commands = parser.add_subparsers(dest="operation", required=True)

    list_parser = commands.add_parser("list", help="list emails")
    list_parser.set_defaults(capability="list-emails")
    list_parser.add_argument("--limit", type=int)
    list_parser.add_argument("--folder")
    list_parser.add_argument("--unread-only", action="store_true")

    read_parser = commands.add_parser("read", help="read one email")
    read_parser.set_defaults(capability="read-email")
    read_parser.add_argument("id")
    read_parser.add_argument(
        "--no-mark-as-read", dest="mark_as_read", action="store_false"
    )
    read_parser.set_defaults(mark_as_read=None)
    return parser


def main(argv=None):
    args = build_parser().parse_args(sys.argv[1:] if argv is None else argv)
    if args.operation == "list":
        payload = {}
        for source, target in (("limit", "limit"), ("folder", "folder")):
            value = getattr(args, source)
            if value is not None:
                payload[target] = value
        if args.unread_only:
            payload["unreadOnly"] = True
    else:
        payload = {"id": args.id}
        if args.mark_as_read is not None:
            payload["markAsRead"] = args.mark_as_read

    os.execvp(
        "tool-proxy",
        ["tool-proxy", args.capability, json.dumps(payload, ensure_ascii=False)],
    )


if __name__ == "__main__":
    raise SystemExit(main())
