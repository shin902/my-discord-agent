#!/usr/bin/env bash
# Capture the Mac's main display, or manage a terminal-started background loop.
set -euo pipefail
umask 077

state_directory="$HOME/Library/Application Support/my-discord-agent/screen-capture"
pidfile="$state_directory/pid"
logfile="$state_directory/capture.log"
capture_directory="$HOME/Library/Application Support/my-discord-agent/screen-captures"
script=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")

pid_is_ours() {
  local process
  [[ "$1" =~ ^[0-9]+$ ]] || return 1
  process=$(ps -p "$1" -o command= 2>/dev/null || true)
  [[ "$process" == *"$script run "* ]]
}

usage() {
  cat >&2 <<EOF
Usage:
  bash $0 <receiver-url> [<UUID>.png]
  bash $0 on <receiver-url> [30|60|300]
  bash $0 off
  bash $0 status
EOF
  exit 1
}

url=""
command="capture"
interval=60
case ${1-} in
  on)
    command=on
    [[ $# -ge 2 && $# -le 3 ]] || usage
    url=$2
    interval=${3:-60}
    ;;
  off|status)
    command=$1
    [[ $# -eq 1 ]] || usage
    ;;
  run)
    command=run
    [[ $# -eq 3 ]] || usage
    url=$2
    interval=$3
    ;;
  *)
    [[ $# -ge 1 && $# -le 2 ]] || usage
    url=$1
    ;;
esac

if [[ "$command" == "off" ]]; then
  if [[ -f "$pidfile" ]]; then
    pid=$(<"$pidfile")
    if pid_is_ours "$pid"; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f -- "$pidfile"
  fi
  echo "Screen capture resident mode: off"
  exit 0
fi
if [[ "$command" == "status" ]]; then
  if [[ -f "$pidfile" ]] && pid_is_ours "$(<"$pidfile")"; then
    echo "Screen capture resident mode: on (pid $(<"$pidfile"))"
    exit 0
  fi
  rm -f -- "$pidfile"
  echo "Screen capture resident mode: off"
  exit 1
fi

valid_receiver_url() {
  local candidate=$1
  if [[ ! "$candidate" =~ ^https://[A-Za-z0-9.-]+\.ts\.net(:[0-9]+)?/v1/screen-captures$ ]]; then
    return 1
  fi
  if [[ "$candidate" =~ ^https://[A-Za-z0-9.-]+\.ts\.net:([0-9]+)/v1/screen-captures$ ]]; then
    local port=${BASH_REMATCH[1]}
    if (( ${#port} > 5 )) || (( 10#$port < 1 || 10#$port > 65535 )); then
      return 1
    fi
  fi
}
if ! valid_receiver_url "$url"; then
  echo "Receiver URL must be an HTTPS .ts.net URL ending in /v1/screen-captures" >&2
  exit 1
fi

if [[ "$command" == "on" ]]; then
  [[ "$interval" =~ ^(30|60|300)$ ]] || {
    echo "Interval must be 30, 60, or 300 seconds" >&2
    exit 1
  }
  if [[ -f "$pidfile" ]] && pid_is_ours "$(<"$pidfile")"; then
    echo "Screen capture resident mode is already on (pid $(<"$pidfile"))"
    exit 0
  fi
  mkdir -p "$state_directory"
  nohup bash "$script" run "$url" "$interval" >>"$logfile" 2>&1 < /dev/null &
  echo $! > "$pidfile"
  echo "Screen capture resident mode: on (every ${interval}s)"
  exit 0
fi

if [[ "$command" == "run" ]]; then
  [[ "$interval" =~ ^[0-9]+$ ]] || exit 1
  mkdir -p "$capture_directory"
  while :; do
    failed=0
    shopt -s nullglob
    pending=("$capture_directory"/*.png)
    shopt -u nullglob
    for image in "${pending[@]}"; do
      bash "$script" "$url" "$image" || failed=1
    done
    if (( failed == 0 )); then
      bash "$script" "$url" || true
    fi
    sleep "$interval"
  done
fi

if [[ $# -eq 2 ]]; then
  image=$2
else
  mkdir -p "$capture_directory"
  image="$capture_directory/$(uuidgen | tr '[:upper:]' '[:lower:]').png"
  screencapture -x -m -t png "$image"
fi
id=$(basename "$image" .png)
if [[ ! -f "$image" || ! "$id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo "Expected an existing <UUID>.png file" >&2
  exit 1
fi
echo "Local capture (pending upload): $image" >&2
status=$(curl -q --silent --show-error --proto '=https' --noproxy '*' \
  --connect-timeout 10 --max-time 60 --output /dev/null --write-out '%{http_code}' \
  --header 'Content-Type: image/png' --header "X-Capture-Id: $id" \
  --data-binary "@$image" "$url") || {
  echo "Upload failed; retry with the same PNG path" >&2
  exit 1
}
if [[ "$status" != 200 ]]; then
  echo "Upload not acknowledged (HTTP $status); PNG retained for retry" >&2
  exit 1
fi
# HTTP 200 confirms the DB commit; no second copy is needed on the Mac.
rm -- "$image"
printf 'Accepted: %s (local PNG deleted)\n' "$id"
