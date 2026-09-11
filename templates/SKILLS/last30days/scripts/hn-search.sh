#!/bin/sh
set -eu
if [ "$#" -eq 1 ] && { [ "$1" = "-h" ] || [ "$1" = "--help" ]; }; then
  echo "Usage: hn-search.sh <TOPIC>"
  exit 0
fi
if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "Usage: hn-search.sh <TOPIC>" >&2
  exit 2
fi
exec tool-proxy hackernews-search "$(python3 -c 'import json,sys; print(json.dumps({"topic": sys.argv[1]}))' "$1")"
