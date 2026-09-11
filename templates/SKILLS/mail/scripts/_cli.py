#!/usr/bin/env python3
"""Thin CLI argument adapter for trusted Microsoft Graph mail capabilities."""
import argparse
import json
import subprocess
import sys


OPERATIONS = {"emails": "list-emails", "email": "read-email"}


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


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        print("Usage: emails.sh [--limit N] [--folder NAME] [--unread-only]")
        print("       email.sh EMAIL_ID [--mark-as-read|--no-mark-as-read]")
        print("Operations: emails, email")
        return 0
    operation = argv[0]
    if operation not in OPERATIONS:
        print(f"unknown operation: {operation}", file=sys.stderr)
        return 2

    if operation == "emails":
        parser = argparse.ArgumentParser(prog="emails.sh", description="List emails via Tool Proxy")
        parser.add_argument("--limit", type=int)
        parser.add_argument("--folder")
        parser.add_argument("--unread-only", action="store_true")
        args = parser.parse_args(argv[1:])
        payload = {}
        if args.limit is not None:
            payload["limit"] = args.limit
        if args.folder is not None:
            payload["folder"] = args.folder
        if args.unread_only:
            payload["unreadOnly"] = True
    else:
        parser = argparse.ArgumentParser(prog="email.sh", description="Read an email via Tool Proxy")
        parser.add_argument("id")
        mark = parser.add_mutually_exclusive_group()
        mark.add_argument("--mark-as-read", dest="mark_as_read", action="store_true")
        mark.add_argument("--no-mark-as-read", dest="mark_as_read", action="store_false")
        parser.set_defaults(mark_as_read=None)
        args = parser.parse_args(argv[1:])
        payload = {"id": args.id}
        if args.mark_as_read is not None:
            payload["markAsRead"] = args.mark_as_read
    return invoke(OPERATIONS[operation], payload)


if __name__ == "__main__":
    raise SystemExit(main())
