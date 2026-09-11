#!/usr/bin/env bash
set -euo pipefail
if [[ $# -eq 1 && ( "$1" == "-h" || "$1" == "--help" ) ]]; then
  echo "Usage: agent-reach.sh <URL>"
  exit 0
fi
if [[ $# -ne 1 || -z "$1" ]]; then
  echo "Usage: agent-reach.sh <URL>" >&2
  exit 2
fi
exec tool-proxy agent-reach "$(python3 -c 'import json,sys; print(json.dumps({"url": sys.argv[1]}))' "$1")"
