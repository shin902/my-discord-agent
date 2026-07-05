#!/bin/sh
# reddit-search.sh <TOPIC>
# クレデンシャルプロキシ経由で Reddit を検索する。
# CREDENTIAL_PROXY_JSON に "reddit" プロバイダーが未設定の場合はスキップして exit 0。
set -eu

TOPIC="${1:-}"

REDDIT_BASE=$(python3 -c "
import os, json, sys
data = json.loads(os.environ.get('CREDENTIAL_PROXY_JSON', '[]'))
for e in data:
    if e.get('provider') == 'reddit':
        print(e['baseUrl']); sys.exit(0)
" 2>/dev/null || true)

if [ -z "$REDDIT_BASE" ]; then
  echo "[Reddit] クレデンシャル未設定のためスキップ"
  exit 0
fi

curl -sG "${REDDIT_BASE}/search.json" \
  -H "User-Agent: research-bot/1.0" \
  --data-urlencode "q=${TOPIC}" \
  --data-urlencode "sort=top" \
  --data-urlencode "t=month" \
  --data-urlencode "limit=10" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for p in data.get('data', {}).get('children', []):
    d = p['data']
    print(f\"[{d.get('score',0)}] r/{d['subreddit']}: {d['title']}\")
    print(f\"  https://reddit.com{d.get('permalink','')}\")
"
