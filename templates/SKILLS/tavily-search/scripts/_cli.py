#!/usr/bin/env python3
"""Thin CLI argument adapter for the trusted tavily-search capability."""
import argparse
import json
import subprocess
import sys


USAGE = "Usage: search.sh QUERY [--max-results N] [--search-depth basic|advanced] [--include-answer|--no-include-answer] [--topic general|news|finance]"


def invoke(payload):
    try:
        result = subprocess.run(
            ["tool-proxy", "tavily-search", json.dumps(payload, ensure_ascii=False)],
            check=False,
        )
    except FileNotFoundError:
        print("tool-proxy is unavailable; update the Runner image", file=sys.stderr)
        return 1
    return result.returncode


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        print(USAGE)
        return 0
    if argv[0] != "search":
        print(f"unknown operation: {argv[0]}", file=sys.stderr)
        return 2

    parser = argparse.ArgumentParser(prog="search.sh", description="Run Tavily web search via Tool Proxy")
    parser.add_argument("query")
    parser.add_argument("--max-results", "--max_results", dest="max_results", type=int)
    parser.add_argument("--search-depth", "--search_depth", dest="search_depth")
    parser.add_argument("--include-answer", dest="include_answer", action="store_true")
    parser.add_argument("--no-include-answer", dest="include_answer", action="store_false")
    parser.set_defaults(include_answer=None)
    parser.add_argument("--topic")
    args = parser.parse_args(argv[1:])

    payload = {"query": args.query}
    if args.max_results is not None:
        payload["max_results"] = args.max_results
    if args.search_depth is not None:
        payload["search_depth"] = args.search_depth
    if args.include_answer is not None:
        payload["include_answer"] = args.include_answer
    if args.topic is not None:
        payload["topic"] = args.topic
    return invoke(payload)


if __name__ == "__main__":
    raise SystemExit(main())
