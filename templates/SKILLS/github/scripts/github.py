#!/usr/bin/env python3
"""Thin subcommand frontend for read-only GitHub capabilities."""
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


def add_repository(parser):
    parser.add_argument("owner")
    parser.add_argument("repo")


def build_parser():
    parser = argparse.ArgumentParser(
        prog="github.py",
        description="Read GitHub Issues and Pull Requests through the shared Tool Proxy",
    )
    commands = parser.add_subparsers(dest="operation", required=True)

    issues = commands.add_parser("issues", help="list Issues, excluding Pull Requests")
    add_repository(issues)
    issues.add_argument("--state")
    issues.add_argument("--limit", type=int)

    issue = commands.add_parser("issue", help="read one Issue")
    add_repository(issue)
    issue.add_argument("issue_number", type=int)

    pull_request = commands.add_parser("pull-request", help="read one Pull Request")
    add_repository(pull_request)
    pull_request.add_argument("pull_number", type=int)

    issue_comments = commands.add_parser("issue-comments", help="list Issue comments")
    add_repository(issue_comments)
    issue_comments.add_argument("issue_number", type=int)

    pull_request_comments = commands.add_parser(
        "pull-request-comments", help="list Pull Request comments"
    )
    add_repository(pull_request_comments)
    pull_request_comments.add_argument("pull_number", type=int)

    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    payload = {"owner": args.owner, "repo": args.repo}

    if args.operation == "issues":
        if args.state is not None:
            payload["state"] = args.state
        if args.limit is not None:
            payload["limit"] = args.limit
    elif args.operation in ("issue", "issue-comments"):
        payload["issue_number"] = args.issue_number
    else:
        payload["pull_number"] = args.pull_number

    return invoke(OPERATIONS[args.operation], payload)


if __name__ == "__main__":
    raise SystemExit(main())
