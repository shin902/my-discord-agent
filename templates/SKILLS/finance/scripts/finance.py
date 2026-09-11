#!/usr/bin/env python3
"""Friendly Finance CLI adapter for the image-owned finance-cli bridge."""
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
            ["finance-cli", OPERATIONS[operation], json.dumps(payload, ensure_ascii=False)],
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


def build_parser():
    parser = argparse.ArgumentParser(
        prog="finance.py",
        description="Record and review finances through the sandbox-local Finance Tool",
    )
    commands = parser.add_subparsers(dest="operation", required=True)

    record = commands.add_parser("record-transaction", help="record income or expense")
    record.add_argument("type")
    record.add_argument("amount", type=int)
    record.add_argument("--date")
    record.add_argument("--category")
    record.add_argument("--description")

    transactions = commands.add_parser("list-transactions", help="list transactions")
    add_date_range(transactions)
    transactions.add_argument("--category")
    transactions.add_argument("--type")
    transactions.add_argument("--limit", type=int)

    summary = commands.add_parser("summary", help="summarize transactions")
    add_date_range(summary)

    add = commands.add_parser("add-subscription", help="add a subscription")
    add.add_argument("name")
    add.add_argument("amount", type=int)
    add.add_argument("cycle")
    add.add_argument("next_date")
    add.add_argument("--category")

    update = commands.add_parser("update-subscription", help="append a subscription update")
    update.add_argument("name")
    update.add_argument("--amount", type=int)
    update.add_argument("--cycle")
    update.add_argument("--next-date", dest="next_date")
    category = update.add_mutually_exclusive_group()
    category.add_argument("--category")
    category.add_argument("--clear-category", action="store_true")
    active = update.add_mutually_exclusive_group()
    active.add_argument("--active", dest="active", action="store_true")
    active.add_argument("--inactive", dest="active", action="store_false")
    update.set_defaults(active=None, clear_category=False)

    cancel = commands.add_parser("cancel-subscription", help="append an inactive snapshot")
    cancel.add_argument("name")

    list_subscriptions = commands.add_parser(
        "list-subscriptions", help="list current subscriptions"
    )
    list_subscriptions.add_argument("--include-inactive", action="store_true")

    history = commands.add_parser(
        "subscription-history", help="list subscription snapshots"
    )
    history.add_argument("name")

    return parser


def input_from_args(args):
    operation = args.operation
    if operation == "record-transaction":
        payload = {"type": args.type, "amount": args.amount}
        put_if_set(payload, "date", args.date)
        put_if_set(payload, "category", args.category)
        put_if_set(payload, "description", args.description)
        return payload
    if operation == "list-transactions":
        payload = {}
        for source, target in (
            ("from_date", "from"),
            ("to_date", "to"),
            ("category", "category"),
            ("type", "type"),
            ("limit", "limit"),
        ):
            put_if_set(payload, target, getattr(args, source))
        return payload
    if operation == "summary":
        payload = {}
        put_if_set(payload, "from", args.from_date)
        put_if_set(payload, "to", args.to_date)
        return payload
    if operation == "add-subscription":
        payload = {
            "name": args.name,
            "amount": args.amount,
            "cycle": args.cycle,
            "nextDate": args.next_date,
        }
        put_if_set(payload, "category", args.category)
        return payload
    if operation == "update-subscription":
        payload = {"name": args.name}
        for source, target in (
            ("amount", "amount"),
            ("cycle", "cycle"),
            ("next_date", "nextDate"),
        ):
            put_if_set(payload, target, getattr(args, source))
        if args.clear_category:
            payload["category"] = None
        else:
            put_if_set(payload, "category", args.category)
        put_if_set(payload, "active", args.active)
        return payload
    if operation == "list-subscriptions":
        return {"includeInactive": True} if args.include_inactive else {}
    return {"name": args.name}


def main(argv=None):
    args = build_parser().parse_args(sys.argv[1:] if argv is None else argv)
    return invoke(args.operation, input_from_args(args))


if __name__ == "__main__":
    raise SystemExit(main())
