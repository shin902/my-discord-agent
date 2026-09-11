#!/usr/bin/env python3
"""Thin CLI argument adapter for the image-owned local Finance Tool runtime."""
import argparse
import json
import subprocess
import sys


OPERATIONS = {
    "record-transaction": "finance-record-transaction",
    "list-transactions": "finance-list-transactions",
    "summary": "finance-summary",
    "add-subscription": "finance-add-subscription",
    "update-subscription": "finance-update-subscription",
    "cancel-subscription": "finance-cancel-subscription",
    "list-subscriptions": "finance-list-subscriptions",
    "subscription-history": "finance-subscription-history",
}


def invoke(operation, payload):
    try:
        result = subprocess.run(
            ["finance-cli", operation, json.dumps(payload, ensure_ascii=False)],
            check=False,
        )
    except FileNotFoundError:
        print("finance-cli is unavailable; update the Runner image", file=sys.stderr)
        return 1
    return result.returncode


def add_date_range(parser):
    parser.add_argument("--from", dest="from_date")
    parser.add_argument("--to", dest="to_date")


def put_if_set(payload, key, value):
    if value is not None:
        payload[key] = value


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        print("Usage: record-transaction.sh | list-transactions.sh | summary.sh | ...")
        print("Operations: " + ", ".join(OPERATIONS))
        return 0
    operation = argv[0]
    if operation not in OPERATIONS:
        print(f"unknown operation: {operation}", file=sys.stderr)
        return 2

    parser = argparse.ArgumentParser(prog=f"{operation}.sh", description=f"Finance {operation} via local Tool")
    if operation == "record-transaction":
        parser.add_argument("type")
        parser.add_argument("amount", type=int)
        parser.add_argument("--date")
        parser.add_argument("--category")
        parser.add_argument("--description")
    elif operation == "list-transactions":
        add_date_range(parser)
        parser.add_argument("--category")
        parser.add_argument("--type")
        parser.add_argument("--limit", type=int)
    elif operation == "summary":
        add_date_range(parser)
    elif operation == "add-subscription":
        parser.add_argument("name")
        parser.add_argument("amount", type=int)
        parser.add_argument("cycle")
        parser.add_argument("next_date")
        parser.add_argument("--category")
    elif operation == "update-subscription":
        parser.add_argument("name")
        parser.add_argument("--amount", type=int)
        parser.add_argument("--cycle")
        parser.add_argument("--next-date", dest="next_date")
        category = parser.add_mutually_exclusive_group()
        category.add_argument("--category")
        category.add_argument("--clear-category", dest="clear_category", action="store_true")
        active = parser.add_mutually_exclusive_group()
        active.add_argument("--active", dest="active", action="store_true")
        active.add_argument("--inactive", dest="active", action="store_false")
        parser.set_defaults(active=None, clear_category=False)
    elif operation == "cancel-subscription" or operation == "subscription-history":
        parser.add_argument("name")
    else:
        parser.add_argument("--include-inactive", action="store_true")
    args = parser.parse_args(argv[1:])

    if operation == "record-transaction":
        payload = {"type": args.type, "amount": args.amount}
        put_if_set(payload, "date", args.date)
        put_if_set(payload, "category", args.category)
        put_if_set(payload, "description", args.description)
    elif operation == "list-transactions":
        payload = {}
        put_if_set(payload, "from", args.from_date)
        put_if_set(payload, "to", args.to_date)
        put_if_set(payload, "category", args.category)
        put_if_set(payload, "type", args.type)
        put_if_set(payload, "limit", args.limit)
    elif operation == "summary":
        payload = {}
        put_if_set(payload, "from", args.from_date)
        put_if_set(payload, "to", args.to_date)
    elif operation == "add-subscription":
        payload = {
            "name": args.name,
            "amount": args.amount,
            "cycle": args.cycle,
            "nextDate": args.next_date,
        }
        put_if_set(payload, "category", args.category)
    elif operation == "update-subscription":
        payload = {"name": args.name}
        put_if_set(payload, "amount", args.amount)
        put_if_set(payload, "cycle", args.cycle)
        put_if_set(payload, "nextDate", args.next_date)
        if args.clear_category:
            payload["category"] = None
        else:
            put_if_set(payload, "category", args.category)
        put_if_set(payload, "active", args.active)
    elif operation == "cancel-subscription" or operation == "subscription-history":
        payload = {"name": args.name}
    else:
        payload = {"includeInactive": True} if args.include_inactive else {}
    return invoke(OPERATIONS[operation], payload)


if __name__ == "__main__":
    raise SystemExit(main())
