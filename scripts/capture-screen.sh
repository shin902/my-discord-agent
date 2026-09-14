#!/usr/bin/env bash
# Capture the Mac's main display, or manage its LaunchAgent.
set -euo pipefail
umask 077

label="com.my-discord-agent.screen-capture"
plist="$HOME/Library/LaunchAgents/$label.plist"
logfile="$HOME/Library/Logs/my-discord-agent-screen-capture.log"
capture_directory="$HOME/Library/Application Support/my-discord-agent/screen-captures"
script=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
domain="gui/$(id -u)"
lock_directory="$plist.lock"

temporary=""
cleanup() {
  [[ -z "$temporary" ]] || rm -f -- "$temporary"
  rm -f -- "$lock_directory"
}

lock_lifecycle() {
  mkdir -p "$(dirname "$lock_directory")"
  while ! shlock -f "$lock_directory" -p "$$"; do sleep 0.05; done
  trap cleanup EXIT
}

unload_agent() {
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    launchctl bootout "$domain/$label"
  fi
}

xml_escape() {
  sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"
}

usage() {
  cat >&2 <<EOF
Usage:
  bash $0 <receiver-url> [<UUID>.png]
  bash $0 on <receiver-url> [seconds]
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
    [[ $# -eq 2 ]] || usage
    url=$2
    ;;
  *)
    [[ $# -ge 1 && $# -le 2 ]] || usage
    url=$1
    ;;
esac

if [[ "$command" == "off" ]]; then
  lock_lifecycle
  unload_agent
  rm -f -- "$plist"
  echo "Screen capture LaunchAgent: off"
  exit 0
fi

if [[ "$command" == "status" ]]; then
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    echo "Screen capture LaunchAgent: on"
    exit 0
  fi
  echo "Screen capture LaunchAgent: off"
  exit 1
fi

valid_receiver_url() {
  local candidate=$1
  if [[ ! "$candidate" =~ ^https://[A-Za-z0-9.-]+\.ts\.net(:[0-9]+)?/v1/screen-captures$ ]]; then
    return 1
  fi
  if [[ "$candidate" =~ ^https://[A-Za-z0-9.-]+\.ts\.net:([0-9]+)/v1/screen-captures$ ]]; then
    local port=${BASH_REMATCH[1]}
    (( ${#port} <= 5 && 10#$port >= 1 && 10#$port <= 65535 )) || return 1
  fi
}
if ! valid_receiver_url "$url"; then
  echo "Receiver URL must be an HTTPS .ts.net URL ending in /v1/screen-captures" >&2
  exit 1
fi

if [[ "$command" == "on" ]]; then
  [[ "$interval" =~ ^[1-9][0-9]*$ ]] || {
    echo "Interval must be a positive number of seconds" >&2
    exit 1
  }
  mkdir -p "$(dirname "$plist")" "$(dirname "$logfile")"
  lock_lifecycle
  escaped_script=$(xml_escape "$script")
  escaped_logfile=$(xml_escape "$logfile")
  temporary="$plist.$$"
  cat >"$temporary" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>$escaped_script</string><string>run</string><string>$url</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>$interval</integer>
  <key>StandardOutPath</key><string>$escaped_logfile</string>
  <key>StandardErrorPath</key><string>$escaped_logfile</string>
</dict></plist>
EOF
  plutil -lint "$temporary" >/dev/null
  unload_agent
  mv -f -- "$temporary" "$plist"
  launchctl bootstrap "$domain" "$plist"
  echo "Screen capture LaunchAgent: on (every ${interval}s)"
  exit 0
fi

if [[ "$command" == "run" ]]; then
  mkdir -p "$capture_directory"
  failed=0
  for image in "$capture_directory"/*.png; do
    [[ -e "$image" ]] || break
    bash "$script" "$url" "$image" || failed=1
  done
  (( failed == 0 )) && bash "$script" "$url" || true
  exit "$failed"
fi

if [[ $# -eq 2 ]]; then
  image=$2
else
  mkdir -p "$capture_directory"
  image="$capture_directory/$(uuidgen | tr '[:upper:]' '[:lower:]').png"
  screencapture -x -m -t png "$image"
  sips -Z 1280 "$image" >/dev/null
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
