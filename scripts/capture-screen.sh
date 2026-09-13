#!/usr/bin/env bash
# Capture the Mac's main display, or manage a terminal-started background loop.
set -euo pipefail
umask 077

state_directory="$HOME/Library/Application Support/my-discord-agent/screen-capture"
worker_marker="$state_directory/worker"
logfile="$state_directory/capture.log"
capture_directory="$HOME/Library/Application Support/my-discord-agent/screen-captures"
script=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")

pid_is_ours() {
  local process
  [[ "$1" =~ ^[0-9]+$ ]] || return 1
  process=$(ps -p "$1" -o command= 2>/dev/null || true)
  [[ "$process" == *"$script run "* ]]
}

current_worker_pid() {
  local pid
  [[ -L "$worker_marker" ]] || return 1
  pid=$(readlink "$worker_marker" 2>/dev/null || true)
  if pid_is_ours "$pid"; then
    printf '%s\n' "$pid"
    return 0
  fi
  rm -f -- "$worker_marker"
  return 1
}

claim_worker() {
  local pid
  mkdir -p "$state_directory"
  while :; do
    if ln -s "$$" "$worker_marker" 2>/dev/null; then
      return 0
    fi
    pid=$(readlink "$worker_marker" 2>/dev/null || true)
    if pid_is_ours "$pid"; then
      return 1
    fi
    rm -f -- "$worker_marker"
  done
}

release_worker() {
  if [[ -L "$worker_marker" ]] && [[ $(readlink "$worker_marker" 2>/dev/null || true) == "$$" ]]; then
    rm -f -- "$worker_marker"
  fi
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
  if pid=$(current_worker_pid); then
    # Stop future scheduling only. A one-shot capture/upload already started by the
    # worker is allowed to finish independently.
    kill "$pid" 2>/dev/null || true
  fi
  echo "Screen capture resident mode: off"
  exit 0
fi

if [[ "$command" == "status" ]]; then
  if pid=$(current_worker_pid); then
    echo "Screen capture resident mode: on (pid $pid)"
    exit 0
  fi
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
  mkdir -p "$state_directory"
  if pid=$(current_worker_pid); then
    echo "Screen capture resident mode is already on (pid $pid)"
    exit 0
  fi
  nohup bash "$script" run "$url" "$interval" >>"$logfile" 2>&1 < /dev/null &
  candidate=$!
  for _ in {1..20}; do
    if pid=$(current_worker_pid); then
      echo "Screen capture resident mode: on (every ${interval}s, pid $pid)"
      exit 0
    fi
    kill -0 "$candidate" 2>/dev/null || break
    sleep 0.05
  done
  echo "Screen capture resident mode failed to start; see $logfile" >&2
  exit 1
fi

if [[ "$command" == "run" ]]; then
  [[ "$interval" =~ ^(30|60|300)$ ]] || exit 1
  # The worker owns one atomic marker. Concurrent `on` calls may launch candidate
  # workers, but only one can claim the marker; stale markers are reclaimed.
  claim_worker || exit 0
  trap 'exit 0' TERM INT
  trap release_worker EXIT
  mkdir -p "$capture_directory"

  run_capture() {
    if [[ -n "$1" ]]; then
      bash "$script" "$url" "$1" &
    else
      bash "$script" "$url" &
    fi
    wait $!
  }

  wait_interval() {
    sleep "$interval" &
    wait $!
  }

  while :; do
    failed=0
    for image in "$capture_directory"/*.png; do
      [[ -e "$image" ]] || break
      run_capture "$image" || failed=1
    done
    if (( failed == 0 )); then
      run_capture "" || true
    fi
    wait_interval || true
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
