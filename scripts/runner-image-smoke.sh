#!/usr/bin/env bash
set -euo pipefail

image="${RUNNER_IMAGE:-my-discord-agent-runner:smoke}"
pnpm build:runner
docker build -t "$image" .
timezone_output="$(docker run --rm "$image" sh -c 'printf "%s\n" "$TZ"; date +%Z')"
printf '%s\n' "$timezone_output"
grep -qx 'Asia/Tokyo' <<<"$timezone_output"
grep -qx 'JST' <<<"$timezone_output"

output="$({ docker run --rm \
  -e SESSIONS_DIR=/tmp/sessions \
  "$image" node /app/runner.mjs --session-store-smoke; } 2>&1)"
printf '%s\n' "$output"
grep -q '^__AGENT_READY__$' <<<"$output"
grep -q '^__SESSION_STORE_SMOKE_OK__$' <<<"$output"
