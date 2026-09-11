#!/usr/bin/env python3
"""Thin subcommand frontend for the arXiv capabilities."""
import argparse
import datetime
import json
import subprocess
import sys


def date_arg(value):
    try:
        if datetime.date.fromisoformat(value).isoformat() != value:
            raise ValueError()
        return value
    except ValueError:
        raise argparse.ArgumentTypeError("date must be YYYY-MM-DD") from None


def invoke(capability, payload, parser):
    try:
        result = subprocess.run(
            ["tool-proxy", capability, json.dumps(payload, ensure_ascii=False)],
            check=False,
        )
    except FileNotFoundError:
        parser.exit(1, "tool-proxy is unavailable; update the Runner image\n")
    return result.returncode


def add_search_options(parser, default_limit, default_sort):
    parser.add_argument("--from", dest="from_date", type=date_arg)
    parser.add_argument("--to", dest="to_date", type=date_arg)
    parser.add_argument("--limit", type=int, choices=range(1, 51), default=default_limit)
    parser.add_argument(
        "--sort",
        choices=("relevance", "submitted", "updated"),
        default=default_sort,
    )


def build_parser():
    parser = argparse.ArgumentParser(
        prog="arxiv.py",
        description="Search arXiv through the shared Tool Proxy",
    )
    commands = parser.add_subparsers(dest="operation", required=True)

    search = commands.add_parser("search", help="focused paper search")
    search.add_argument("query")
    add_search_options(search, 10, "relevance")

    survey = commands.add_parser("survey", help="OR search across related queries")
    survey.add_argument("queries", nargs="+")
    add_search_options(survey, 30, "submitted")

    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)

    queries = [args.query] if args.operation == "search" else args.queries
    if args.operation == "survey" and len(queries) > 8:
        parser.error("at most 8 queries may be supplied")
    if any(not query.strip() for query in queries):
        parser.error("query must not be empty")
    if args.from_date and args.to_date and args.from_date > args.to_date:
        parser.error("from must not be after to")

    payload = {
        "query": queries[0],
        "max_results": args.limit,
        "sort": args.sort,
    }
    capability = "arxiv-search"
    if args.operation == "survey":
        payload = {
            "queries": queries,
            "max_results": args.limit,
            "sort": args.sort,
        }
        capability = "arxiv-survey"
    if args.from_date:
        payload["from"] = args.from_date
    if args.to_date:
        payload["to"] = args.to_date
    return invoke(capability, payload, parser)


if __name__ == "__main__":
    raise SystemExit(main())
