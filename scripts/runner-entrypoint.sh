#!/bin/sh
set -eu

# The Agent Runner is intentionally allowed to reach only the host gateway on
# ports assembled by the host manager.  Do not add DNS, loopback, private-range,
# or public-range exceptions here: arbitrary programs in the Runner must share
# this same kernel-enforced policy.
: "${RUNNER_UID:?RUNNER_UID is not set}"
: "${RUNNER_GID:?RUNNER_GID is not set}"

fail() {
  echo "runner network policy: $*" >&2
  exit 1
}

case "$RUNNER_UID" in
  ''|*[!0-9]*) fail "RUNNER_UID must be a decimal uid" ;;
esac
case "$RUNNER_GID" in
  ''|*[!0-9]*) fail "RUNNER_GID must be a decimal gid" ;;
esac
[ "$RUNNER_UID" -gt 0 ] || fail "RUNNER_UID must be non-root"
[ "$RUNNER_GID" -gt 0 ] || fail "RUNNER_GID must be non-root"

# Docker writes the host-gateway address into /etc/hosts for --add-host.  Use
# that exact address rather than allowing an entire Docker bridge/private CIDR.
host_gateway=$(awk '
  $1 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ {
    for (i = 2; i <= NF; i++) {
      if ($i == "host.docker.internal") {
        print $1
        exit
      }
    }
  }
' /etc/hosts)
[ -n "$host_gateway" ] || fail "host.docker.internal is not present in /etc/hosts"

validate_ipv4() {
  address="$1"
  old_ifs=$IFS
  IFS=.
  set -- $address
  IFS=$old_ifs
  [ "$#" -eq 4 ] || fail "invalid host gateway address: $address"
  for octet in "$@"; do
    case "$octet" in
      ''|*[!0-9]*) fail "invalid host gateway address: $address" ;;
    esac
    [ "$octet" -le 255 ] || fail "invalid host gateway address: $address"
  done
}
validate_ipv4 "$host_gateway"

allowed_ports=$(printf '%s' "${RUNNER_ALLOWED_HOST_PORTS:-}" | tr ',' ' ')
for port in $allowed_ports; do
  case "$port" in
    ''|*[!0-9]*) fail "invalid allowed host port: $port" ;;
  esac
  [ "$port" -ge 1 ] && [ "$port" -le 65535 ] ||
    fail "allowed host port is out of range: $port"
done

command -v iptables >/dev/null 2>&1 || fail "iptables is required"
command -v ip6tables >/dev/null 2>&1 || fail "ip6tables is required"
command -v setpriv >/dev/null 2>&1 || fail "setpriv is required"

# Flush only the namespace-local OUTPUT chain, then make the default policy
# deny.  Replies to an explicitly allowed connection remain usable; no new
# connection can use localhost, RFC1918/LAN, CGNAT/Tailscale, link-local,
# metadata, or arbitrary public Internet addresses.
iptables -F OUTPUT
iptables -P OUTPUT DROP
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for port in $allowed_ports; do
  iptables -A OUTPUT -d "$host_gateway" -p tcp --dport "$port" \
    -m conntrack --ctstate NEW -j ACCEPT
done

# IPv6 has no host-gateway exception in this Runner contract.  Keep the
# established rule so a future explicitly approved IPv6 path cannot accidentally
# be made impossible by this setup, but deny every new IPv6 connection here.
ip6tables -F OUTPUT
ip6tables -P OUTPUT DROP
ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# iptables needs CAP_NET_ADMIN only while the policy is installed.  The Docker
# invocation grants SETUID/SETGID/SETPCAP only for this transition as well.
# Drop the capability bounding, inheritable, ambient, and effective sets before running
# Node, bash, Python, curl, or any other Agent child process.
exec setpriv \
  --reuid "$RUNNER_UID" \
  --regid "$RUNNER_GID" \
  --clear-groups \
  --bounding-set=-all \
  --inh-caps=-all \
  --ambient-caps=-all \
  -- "$@"
