#!/usr/bin/env python3
"""Thin CLI argument adapter for the trusted GitHub comment capability."""
import argparse
import json
import subprocess
import sys


def invoke(payload):
    try:
        result = subprocess.run(
            ["tool-proxy", "comment-issue", json.dumps(payload, ensure_ascii=False)],
            check=False,
        )
    except FileNotFoundError:
        print("tool-proxy is unavailable; update the Runner image", file=sys.stderr)
        return 1
    return result.returncode


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(
        prog="comment-issue.sh",
        description="Post a Markdown comment to a GitHub issue via Tool Proxy",
    )
    parser.add_argument("owner")
    parser.add_argument("repo")
    parser.add_argument("issue_number", type=int)
    parser.add_argument("body", nargs="?")
    parser.add_argument("--body", dest="body_option")
    args = parser.parse_args(argv)
    body = args.body_option if args.body_option is not None else args.body
    if body is None:
        parser.error("body is required")
    return invoke(
        {
            "owner": args.owner,
            "repo": args.repo,
            "issue_number": args.issue_number,
            "body": body,
        }
    )


if __name__ == "__main__":
    raise SystemExit(main())
