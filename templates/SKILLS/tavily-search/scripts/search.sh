#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: search.sh QUERY [--max-results N] [--search-depth basic|advanced] [--include-answer|--no-include-answer] [--topic general|news|finance]

Call the existing tavily-search capability through Tool Proxy.
EOF
}

if [[ $# -eq 1 && ( "$1" == "-h" || "$1" == "--help" ) ]]; then
  usage
  exit 0
fi

query=""
max_results=""
search_depth=""
include_answer=""
topic=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --max-results|--max_results)
      [[ $# -ge 2 ]] || { echo "missing value for $1" >&2; exit 2; }
      max_results=$2
      shift 2
      ;;
    --search-depth|--search_depth)
      [[ $# -ge 2 ]] || { echo "missing value for $1" >&2; exit 2; }
      search_depth=$2
      shift 2
      ;;
    --include-answer)
      include_answer=true
      shift
      ;;
    --no-include-answer)
      include_answer=false
      shift
      ;;
    --topic)
      [[ $# -ge 2 ]] || { echo "missing value for $1" >&2; exit 2; }
      topic=$2
      shift 2
      ;;
    --)
      shift
      [[ $# -ge 1 && -z "$query" ]] || { echo "query is required" >&2; exit 2; }
      query=$1
      shift
      ;;
    -*)
      echo "unknown option: $1" >&2
      exit 2
      ;;
    *)
      [[ -z "$query" ]] || { echo "only one query is supported" >&2; exit 2; }
      query=$1
      shift
      ;;
  esac
done

[[ -n "$query" ]] || { echo "query is required" >&2; exit 2; }
json=$(python3 - "$query" "$max_results" "$search_depth" "$include_answer" "$topic" <<'PY'
import json
import sys

query, max_results, search_depth, include_answer, topic = sys.argv[1:]
payload = {"query": query}
if max_results:
    payload["max_results"] = int(max_results)
if search_depth:
    payload["search_depth"] = search_depth
if include_answer:
    payload["include_answer"] = include_answer == "true"
if topic:
    payload["topic"] = topic
print(json.dumps(payload, ensure_ascii=False))
PY
)
exec tool-proxy tavily-search "$json"
