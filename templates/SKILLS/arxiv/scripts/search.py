#!/usr/bin/env python3
"""Preserve the Skill CLI; acquisition and normalization belong to Tool Runtime."""
import argparse
import datetime
import json
import subprocess


def date_arg(value):
    try:
        if datetime.date.fromisoformat(value).isoformat() != value:
            raise ValueError()
        return value
    except ValueError:
        raise argparse.ArgumentTypeError("date must be YYYY-MM-DD") from None


def main():
    parser = argparse.ArgumentParser(description="arxiv-search via Tool Proxy")
    parser.add_argument("query")
    parser.add_argument("--from", dest="from_date", type=date_arg)
    parser.add_argument("--to", dest="to_date", type=date_arg)
    parser.add_argument("--limit", type=int, choices=range(1, 51), default=10)
    parser.add_argument("--sort", choices=("relevance", "submitted", "updated"), default="relevance")
    args = parser.parse_args()
    if not args.query.strip():
        parser.error("query must not be empty")
    if args.from_date and args.to_date and args.from_date > args.to_date:
        parser.error("from must not be after to")
    payload = {"query": args.query, "max_results": args.limit, "sort": args.sort}
    if args.from_date:
        payload["from"] = args.from_date
    if args.to_date:
        payload["to"] = args.to_date
    try:
        result = subprocess.run(["tool-proxy", "arxiv-search", json.dumps(payload)], check=False)
    except FileNotFoundError:
        parser.exit(1, "tool-proxy is unavailable; update the Runner image\n")
    raise SystemExit(result.returncode)


if __name__ == "__main__":
    main()
