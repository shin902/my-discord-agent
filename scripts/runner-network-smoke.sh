#!/usr/bin/env bash
set -euo pipefail

image="${RUNNER_IMAGE:-my-discord-agent-runner:smoke}"
ready_file="$(mktemp)"
server_log="$(mktemp)"
server_pid=""
cleanup() {
  if [[ -n "${server_pid}" ]]; then
    kill "${server_pid}" 2>/dev/null || true
    wait "${server_pid}" 2>/dev/null || true
  fi
  rm -f "${ready_file}" "${server_log}"
}
trap cleanup EXIT

# Expose two real host listeners: one approved port and one intentionally
# unapproved port. This makes the allow/deny assertions distinguish firewall
# behavior from a naturally closed destination.
python3 - "${ready_file}" >"${server_log}" 2>&1 <<'PY' &
import pathlib
import select
import socket
import sys

ready = pathlib.Path(sys.argv[1])
listeners = []
try:
    for _ in range(2):
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("0.0.0.0", 0))
        listener.listen()
        listeners.append(listener)
    ready.write_text(",".join(str(listener.getsockname()[1]) for listener in listeners) + "\n")
    while True:
        readable, _, _ = select.select(listeners, [], [], 1)
        for listener in readable:
            connection, _ = listener.accept()
            try:
                connection.recv(4096)
                connection.sendall(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n"
                    b"Connection: close\r\n\r\nOK"
                )
            finally:
                connection.close()
finally:
    for listener in listeners:
        listener.close()
PY
server_pid=$!

for _ in {1..50}; do
  if [[ -s "${ready_file}" ]]; then
    break
  fi
  sleep 0.1
done
[[ -s "${ready_file}" ]] || {
  cat "${server_log}" >&2
  echo "host test server did not start" >&2
  exit 1
}

IFS=, read -r allowed_port denied_port <"${ready_file}"
[[ -n "${allowed_port}" && -n "${denied_port}" ]] || {
  echo "host test server did not publish two ports" >&2
  exit 1
}

uid="$(id -u)"
gid="$(id -g)"

docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  --cap-drop=ALL \
  --cap-add=NET_ADMIN \
  --cap-add=SETUID \
  --cap-add=SETGID \
  --cap-add=SETPCAP \
  --security-opt=no-new-privileges=true \
  -e "RUNNER_UID=${uid}" \
  -e "RUNNER_GID=${gid}" \
  -e "RUNNER_ALLOWED_HOST_PORTS=${allowed_port}" \
  -e "RUNNER_TEST_ALLOWED_PORT=${allowed_port}" \
  -e "RUNNER_TEST_DENIED_PORT=${denied_port}" \
  "${image}" \
  sh -eu -c '
    expect_denied() {
      if curl --noproxy "*" --silent --show-error --connect-timeout 1 --max-time 2 "$1" >/dev/null; then
        echo "unexpectedly reachable: $1" >&2
        exit 1
      fi
    }

    # The approved host port represents the current Credential Proxy/LLM
    # route and, when selected, the Tool Proxy route. Network policy does not
    # replace their HTTP/token authorization, so exercise their real path
    # shapes without making this smoke depend on a live application server.
    for path in /__tool-proxy/rpc /__agent/bot /codex-oauth/v1/responses; do
      curl --noproxy "*" --fail --silent --show-error --connect-timeout 2 --max-time 3 \
        "http://host.docker.internal:${RUNNER_TEST_ALLOWED_PORT}${path}" >/dev/null
    done

    # The same host gateway is reachable only on the manager-approved port.
    expect_denied "http://host.docker.internal:${RUNNER_TEST_DENIED_PORT}/"

    # A listener inside this namespace proves that loopback is not an implicit
    # exception in OUTPUT. The other addresses cover public, RFC1918, CGNAT,
    # link-local/metadata, and IPv6 loopback destinations.
    python3 - <<"PY" &
import socket
listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", 18765))
listener.listen()
while True:
    connection, _ = listener.accept()
    connection.close()
PY
    local_pid=$!
    trap "kill ${local_pid} 2>/dev/null || true" EXIT
    sleep 0.1
    expect_denied "http://127.0.0.1:18765/"
    expect_denied "http://1.1.1.1:80/"
    expect_denied "http://10.0.0.1:80/"
    expect_denied "http://172.16.0.1:80/"
    expect_denied "http://192.168.1.1:80/"
    expect_denied "http://100.64.0.1:80/"
    expect_denied "http://169.254.169.254:80/"
    expect_denied "http://[::1]:80/"
  '

echo "Runner network boundary smoke passed: allowed host port ${allowed_port}; denied public/loopback/private/CGNAT/link-local/IPv6 paths"
