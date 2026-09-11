#!/usr/bin/env python3
"""Thin subcommand frontend for read-only GitHub capabilities."""
import argparse
import json
import os
import sys


def add_repository(parser):
    parser.add_argument("owner")
    parser.add_argument("repo")


def build_parser():
    parser = argparse.ArgumentParser(
        prog="github.py", description="Read GitHub data through Tool Proxy"
    )
    commands = parser.add_subparsers(dest="operation", required=True)

    issues = commands.add_parser("issues", help="list Issues")
    issues.set_defaults(capability="list-issues")
    add_repository(issues)
    issues.add_argument("--state")
    issues.add_argument("--limit", type=int)

    issue = commands.add_parser("issue", help="read an Issue")
    issue.set_defaults(capability="read-issue")
    add_repository(issue)
    issue.add_argument("issue_number", type=int)

    pull_request = commands.add_parser("pull-request", help="read a Pull Request")
    pull_request.set_defaults(capability="read-pull-request")
    add_repository(pull_request)
    pull_request.add_argument("pull_number", type=int)

    issue_comments = commands.add_parser("issue-comments", help="list Issue comments")
    issue_comments.set_defaults(capability="list-issue-comments")
    add_repository(issue_comments)
    issue_comments.add_argument("issue_number", type=int)

    pull_request_comments = commands.add_parser(
        "pull-request-comments", help="list Pull Request comments"
    )
    pull_request_comments.set_defaults(capability="list-pull-request-comments")
    add_repository(pull_request_comments)
    pull_request_comments.add_argument("pull_number", type=int)
    return parser


def main(argv=None):
    args = build_parser().parse_args(sys.argv[1:] if argv is None else argv)
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

    os.execvp(
        "tool-proxy",
        ["tool-proxy", args.capability, json.dumps(payload, ensure_ascii=False)],
    )


if __name__ == "__main__":
    raise SystemExit(main())
