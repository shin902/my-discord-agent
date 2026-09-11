#!/usr/bin/env python3
"""Thin subcommand frontend for the arXiv capabilities."""
import argparse
import json
import os
import sys


def add_search_options(parser):
    parser.add_argument("--from", dest="from_date")
    parser.add_argument("--to", dest="to_date")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--sort")


def build_parser():
    parser = argparse.ArgumentParser(
        prog="arxiv.py", description="Search arXiv through Tool Proxy"
    )
    commands = parser.add_subparsers(dest="operation", required=True)

    search = commands.add_parser("search", help="search papers")
    search.add_argument("query")
    add_search_options(search)

    survey = commands.add_parser("survey", help="search with multiple queries")
    survey.add_argument("queries", nargs="+")
    add_search_options(survey)
    return parser


def main(argv=None):
    args = build_parser().parse_args(sys.argv[1:] if argv is None else argv)
    if args.operation == "search":
        capability = "arxiv-search"
        payload = {"query": args.query}
    else:
        capability = "arxiv-survey"
        payload = {"queries": args.queries}

    for source, target in (
        ("from_date", "from"),
        ("to_date", "to"),
        ("limit", "max_results"),
        ("sort", "sort"),
    ):
        value = getattr(args, source)
        if value is not None:
            payload[target] = value

    os.execvp(
        "tool-proxy",
        ["tool-proxy", capability, json.dumps(payload, ensure_ascii=False)],
    )


if __name__ == "__main__":
    raise SystemExit(main())
