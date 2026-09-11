#!/usr/bin/env python3
"""Thin CLI argument adapter for trusted read-only GitHub capabilities."""
import argparse
import json
import subprocess
import sys


OPERATIONS = {
    "issues": "list-issues",
    "issue": "read-issue",
    "pull-request": "read-pull-request",
    "issue-comments": "list-issue-comments",
    "pull-request-comments": "list-pull-request-comments",
}


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


def repository_args(parser):
    parser.add_argument("owner")
    parser.add_argument("repo")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        print("Usage: <issues.sh|issue.sh|pull-request.sh|issue-comments.sh|pull-request-comments.sh> ...")
        print("Operations: issues, issue, pull-request, issue-comments, pull-request-comments")
        return 0
    operation = argv[0]
    if operation not in OPERATIONS:
        print(f"unknown operation: {operation}", file=sys.stderr)
        return 2

    parser = argparse.ArgumentParser(prog=f"{operation}.sh", description=f"GitHub {operation} via Tool Proxy")
    repository_args(parser)
    if operation == "issues":
        parser.add_argument("--state")
        parser.add_argument("--limit", type=int)
    elif operation in ("issue", "issue-comments"):
        parser.add_argument("issue_number", type=int)
    else:
        parser.add_argument("pull_number", type=int)
    args = parser.parse_args(argv[1:])

    payload = {"owner": args.owner, "repo": args.repo}
    if operation == "issues":
        if args.state is not None:
            payload["state"] = args.state
        if args.limit is not None:
            payload["limit"] = args.limit
    elif operation in ("issue", "issue-comments"):
        payload["issue_number"] = args.issue_number
    else:
        payload["pull_number"] = args.pull_number
    return invoke(OPERATIONS[operation], payload)


if __name__ == "__main__":
    raise SystemExit(main())
