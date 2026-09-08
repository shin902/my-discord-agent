#!/bin/sh
set -eu
if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "Usage: reddit-search.sh <TOPIC>" >&2
  exit 2
fi
args=$(python3 -c 'import json,sys,urllib.parse; print(json.dumps({"url": "https://www.reddit.com/search.json?" + urllib.parse.urlencode({"q": sys.argv[1], "sort": "top", "t": "month", "limit": "10"})}))' "$1")
exec tool-proxy agent-reach "$args"
