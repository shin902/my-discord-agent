#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: comment-issue.sh OWNER REPO ISSUE_NUMBER BODY
       comment-issue.sh OWNER REPO ISSUE_NUMBER --body BODY

Post a Markdown comment through the existing comment-issue capability.
EOF
}

if [[ $# -eq 1 && ( "$1" == "-h" || "$1" == "--help" ) ]]; then
  usage
  exit 0
fi
if [[ $# -lt 4 ]]; then
  usage >&2
  exit 2
fi

owner=$1
repo=$2
issue_number=$3
shift 3
if [[ "$1" == "--body" ]]; then
  [[ $# -eq 2 ]] || { echo "--body requires exactly one value" >&2; exit 2; }
  body=$2
else
  [[ $# -eq 1 ]] || { echo "body must be one argument" >&2; exit 2; }
  body=$1
fi
json=$(python3 - "$owner" "$repo" "$issue_number" "$body" <<'PY'
import json
import sys

owner, repo, issue_number, body = sys.argv[1:]
print(json.dumps({
    "owner": owner,
    "repo": repo,
    "issue_number": int(issue_number),
    "body": body,
}, ensure_ascii=False))
PY
)
exec tool-proxy comment-issue "$json"
