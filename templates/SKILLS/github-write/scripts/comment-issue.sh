#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: comment-issue.sh OWNER REPO ISSUE_NUMBER BODY"
}

if [[ $# -eq 1 && ( "$1" == "-h" || "$1" == "--help" ) ]]; then
  usage
  exit 0
fi
if [[ $# -ne 4 ]]; then
  usage >&2
  exit 2
fi

json=$(python3 -c '
import json
import sys

owner, repo, issue_number, body = sys.argv[1:]
print(json.dumps({
    "owner": owner,
    "repo": repo,
    "issue_number": int(issue_number),
    "body": body,
}, ensure_ascii=False))
' "$@")
exec tool-proxy comment-issue "$json"
