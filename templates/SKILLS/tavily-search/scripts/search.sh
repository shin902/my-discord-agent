#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: search.sh QUERY [--max-results N] [--search-depth DEPTH] [--no-include-answer] [--topic TOPIC]"
}

if [[ $# -eq 1 && ( "$1" == "-h" || "$1" == "--help" ) ]]; then
  usage
  exit 0
fi
if [[ $# -lt 1 ]]; then
  usage >&2
  exit 2
fi

query=$1
shift
max_results=
search_depth=
include_answer=
topic=
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-results)
      [[ $# -ge 2 ]] || { echo "missing value for --max-results" >&2; exit 2; }
      max_results=$2
      shift 2
      ;;
    --search-depth)
      [[ $# -ge 2 ]] || { echo "missing value for --search-depth" >&2; exit 2; }
      search_depth=$2
      shift 2
      ;;
    --no-include-answer)
      include_answer=false
      shift
      ;;
    --topic)
      [[ $# -ge 2 ]] || { echo "missing value for --topic" >&2; exit 2; }
      topic=$2
      shift 2
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 2
      ;;
  esac
done

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
