#!/bin/sh
set -eu

# Install the sandbox egress boundary before any Agent-controlled process starts.
# The runner may contact only the host gateway ports selected by the trusted host
# manager. Public Internet, localhost, LAN/private, link-local/metadata, Docker
# peers, DNS, and every other host port fall through to the final reject.
: "${RUNNER_UID:?RUNNER_UID is not set}"
: "${RUNNER_GID:?RUNNER_GID is not set}"
: "${RUNNER_ALLOWED_HOST_PORTS:?RUNNER_ALLOWED_HOST_PORTS is not set}"

case "$RUNNER_UID" in
  ''|*[!0-9]*|0)
    echo "runner UID must be a non-root numeric value" >&2
    exit 1
    ;;
esac
case "$RUNNER_GID" in
  ''|*[!0-9]*|0)
    echo "runner GID must be a non-root numeric value" >&2
    exit 1
    ;;
esac

host_gateway=$(
  awk '$2 == "host.docker.internal" { print $1; exit }' /etc/hosts
)
[ -n "$host_gateway" ] || {
  echo "host.docker.internal is not present in /etc/hosts" >&2
  exit 1
}

iptables -P OUTPUT DROP
ip6tables -P OUTPUT DROP
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

old_ifs=$IFS
IFS=,
for port in $RUNNER_ALLOWED_HOST_PORTS; do
  case "$port" in
    ''|*[!0-9]*)
      echo "invalid allowed host port: $port" >&2
      exit 1
      ;;
  esac
  [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || {
    echo "allowed host port is out of range: $port" >&2
    exit 1
  }
  iptables -A OUTPUT -p tcp -d "$host_gateway" --dport "$port" -j ACCEPT
done
IFS=$old_ifs

iptables -A OUTPUT -j REJECT
ip6tables -A OUTPUT -j REJECT

# Setup capabilities exist only while this script installs the policy and
# changes identity. Drop the complete capability bounding set and switch to the
# configured non-root identity before executing the Agent runner, so Agent code
# cannot change the firewall or regain privileges.
command -v setpriv >/dev/null 2>&1 || {
  echo "setpriv is required to drop sandbox setup privileges" >&2
  exit 1
}
exec setpriv \
  --reuid "$RUNNER_UID" \
  --regid "$RUNNER_GID" \
  --clear-groups \
  --bounding-set=-all \
  --inh-caps=-all \
  --ambient-caps=-all \
  -- "$@"
