#!/bin/sh
set -eu

# Only this image-owned bootstrap runs with privileges. Do not read or execute
# anything from /workspace, /sessions, or stdin before dropping them.
: "${SANDBOX_UID:?SANDBOX_UID is required}"
: "${SANDBOX_GID:?SANDBOX_GID is required}"
: "${SANDBOX_PROXY_PORTS:?SANDBOX_PROXY_PORTS is required}"
for identity in "$SANDBOX_UID" "$SANDBOX_GID"; do
  case "$identity" in ''|*[!0-9]*) exit 1 ;; esac
  [ "$identity" -gt 0 ] || { echo 'Sandbox identity must be non-root' >&2; exit 1; }
done

# Use Docker's static hosts entry, never DNS or an Agent-controlled resolver.
gateway=$(awk '$2 == "host.docker.internal" && $1 ~ /^[0-9.]+$/ { print $1 }' /etc/hosts)
[ -n "$gateway" ] || { echo 'IPv4 host-gateway is required' >&2; exit 1; }

# Any unsupported family / failed rule aborts startup. No unconfined fallback.
iptables -P OUTPUT DROP
ip6tables -P OUTPUT DROP
for port in $SANDBOX_PROXY_PORTS; do
  case "$port" in ''|*[!0-9]*) exit 1 ;; esac
  [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || exit 1
  iptables -A OUTPUT -d "$gateway" -p tcp --dport "$port" -j ACCEPT
done
# No blanket loopback, DNS, UDP, or ESTABLISHED/RELATED exception.
iptables -A OUTPUT -j REJECT
ip6tables -A OUTPUT -j REJECT

exec setpriv --reuid "$SANDBOX_UID" --regid "$SANDBOX_GID" \
  --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all \
  --no-new-privs -- "$@"
