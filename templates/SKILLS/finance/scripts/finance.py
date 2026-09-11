#!/usr/bin/env python3
"""Thin frontend for the sandbox-local Finance Tool bridge."""
import argparse
import json
import os
import sys


def add_date_range(parser):
    parser.add_argument("--from", dest="from_date")
    parser.add_argument("--to", dest="to_date")


def add_set(payload, args, fields):
    for source, target in fields:
        value = getattr(args, source)
        if value is not None:
            payload[target] = value


def build_parser():
    parser = argparse.ArgumentParser(
        prog="finance.py", description="Use sandbox-local Finance Tools"
    )
    commands = parser.add_subparsers(dest="operation", required=True)

    record = commands.add_parser("record-transaction", help="record a transaction")
    record.set_defaults(capability="finance-record-transaction")
    record.add_argument("type")
    record.add_argument("amount", type=int)
    record.add_argument("--date")
    record.add_argument("--category")
    record.add_argument("--description")

    transactions = commands.add_parser("list-transactions", help="list transactions")
    transactions.set_defaults(capability="finance-list-transactions")
    add_date_range(transactions)
    transactions.add_argument("--category")
    transactions.add_argument("--type")
    transactions.add_argument("--limit", type=int)

    summary = commands.add_parser("summary", help="summarize transactions")
    summary.set_defaults(capability="finance-summary")
    add_date_range(summary)

    add = commands.add_parser("add-subscription", help="add a subscription")
    add.set_defaults(capability="finance-add-subscription")
    add.add_argument("name")
    add.add_argument("amount", type=int)
    add.add_argument("cycle")
    add.add_argument("next_date")
    add.add_argument("--category")

    update = commands.add_parser("update-subscription", help="update a subscription")
    update.set_defaults(capability="finance-update-subscription")
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

    cancel = commands.add_parser("cancel-subscription", help="cancel a subscription")
    cancel.set_defaults(capability="finance-cancel-subscription")
    cancel.add_argument("name")

    subscriptions = commands.add_parser(
        "list-subscriptions", help="list subscriptions"
    )
    subscriptions.set_defaults(capability="finance-list-subscriptions")
    subscriptions.add_argument("--include-inactive", action="store_true")

    history = commands.add_parser(
        "subscription-history", help="list subscription history"
    )
    history.set_defaults(capability="finance-subscription-history")
    history.add_argument("name")
    return parser


def main(argv=None):
    args = build_parser().parse_args(sys.argv[1:] if argv is None else argv)
    if args.operation == "record-transaction":
        payload = {"type": args.type, "amount": args.amount}
        add_set(payload, args, (("date", "date"), ("category", "category"), ("description", "description")))
    elif args.operation == "list-transactions":
        payload = {}
        add_set(
            payload,
            args,
            (("from_date", "from"), ("to_date", "to"), ("category", "category"), ("type", "type"), ("limit", "limit")),
        )
    elif args.operation == "summary":
        payload = {}
        add_set(payload, args, (("from_date", "from"), ("to_date", "to")))
    elif args.operation == "add-subscription":
        payload = {
            "name": args.name,
            "amount": args.amount,
            "cycle": args.cycle,
            "nextDate": args.next_date,
        }
        add_set(payload, args, (("category", "category"),))
    elif args.operation == "update-subscription":
        payload = {"name": args.name}
        add_set(
            payload,
            args,
            (("amount", "amount"), ("cycle", "cycle"), ("next_date", "nextDate")),
        )
        if args.clear_category:
            payload["category"] = None
        else:
            add_set(payload, args, (("category", "category"),))
        add_set(payload, args, (("active", "active"),))
    elif args.operation == "list-subscriptions":
        payload = {"includeInactive": True} if args.include_inactive else {}
    else:
        payload = {"name": args.name}

    os.execvp(
        "finance-cli",
        ["finance-cli", args.capability, json.dumps(payload, ensure_ascii=False)],
    )


if __name__ == "__main__":
    raise SystemExit(main())
