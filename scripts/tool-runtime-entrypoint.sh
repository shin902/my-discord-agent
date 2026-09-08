#!/bin/sh
set -eu

# The runtime needs public egress, but must not become a bridge into the host or
# private networks. Docker's embedded DNS is the one loopback exception.
# Every rule is required: set -e deliberately makes a missing firewall or an
# unsupported address family fail closed instead of starting an unconfined
# runtime.
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# Docker's embedded DNS traffic is NATed inside the namespace before it
# reaches OUTPUT, so matching port 53 / 127.0.0.11 is not reliable. Allow
# loopback before the private-range rejects; application-layer destination
# validation remains the agent-reach boundary for fetched URLs.
iptables -A OUTPUT -d 127.0.0.0/8 -j ACCEPT
for cidr in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
  iptables -A OUTPUT -d "$cidr" -j REJECT
done
# Keep this list in lockstep with isPublicIpAddress() in agent-reach.ts.
for cidr in ::/96 ::1/128 fc00::/7 fe80::/10 fec0::/10 ff00::/8 \
  100::/64 2001::/23 2001:db8::/32 2002::/16 3fff::/20 5f00::/16 \
  64:ff9b:1::/48 100:0:0:1::/64; do
  ip6tables -A OUTPUT -d "$cidr" -j REJECT
done

# Firewall installation needs temporary root capabilities. Non-Reddit calls use
# the image's unprivileged UID/GID; Reddit calls use the validated state owner.
state_uid=${TOOL_RUNTIME_UID:-1000}
state_gid=${TOOL_RUNTIME_GID:-1000}
case "$state_uid:$state_gid" in
  *[!0-9:]*|*:*:*|0:*|*:0|:*|*:)
    echo "Tool Runtime UID/GID must be positive integers" >&2
    exit 1
    ;;
esac

command -v setpriv >/dev/null 2>&1 || {
  echo "setpriv is required to drop capabilities" >&2
  exit 1
}
exec setpriv \
  --reuid "$state_uid" \
  --regid "$state_gid" \
  --clear-groups \
  --bounding-set=-all \
  --inh-caps=-all \
  --ambient-caps=-all \
  -- "$@"
