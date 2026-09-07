#!/bin/sh
set -eu
if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "Usage: hn-search.sh <TOPIC>" >&2
  exit 2
fi
exec tool-proxy hackernews-search "$(python3 -c 'import json,sys; print(json.dumps({"topic": sys.argv[1]}))' "$1")"
