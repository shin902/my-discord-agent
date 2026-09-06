#!/bin/sh
set -eu

# The runtime needs public egress, but must not become a bridge into the host or
# private networks. Docker's embedded DNS is the one loopback exception. Replies
# to the published localhost port are established traffic and must be allowed.
# Every rule is required: set -e deliberately makes a missing firewall or an
# unsupported address family fail closed instead of starting an unconfined
# runtime.
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -d 127.0.0.11 -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -d 127.0.0.11 -p tcp --dport 53 -j ACCEPT
for cidr in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
  iptables -A OUTPUT -d "$cidr" -j REJECT
done
# Keep this list in lockstep with isPublicIpAddress() in agent-reach.ts.
for cidr in ::/96 ::1/128 fc00::/7 fe80::/10 fec0::/10 ff00::/8 \
  100::/64 2001::/23 2001:db8::/32 2002::/16 3fff::/20 5f00::/16 \
  64:ff9b:1::/48 100:0:0:1::/64; do
  ip6tables -A OUTPUT -d "$cidr" -j REJECT
done

# iptables needs CAP_NET_ADMIN only while the policy is installed. The state
# mounts are created by the host login process, so derive the runtime identity
# from the configured mounts instead of assuming the image's `node` UID matches
# the host UID. Refuse root, symlinks, missing state, and mixed ownership.
: "${REDDIT_PROFILE_DIR:?REDDIT_PROFILE_DIR is not set}"
: "${REDDIT_COOKIE_FILE:?REDDIT_COOKIE_FILE is not set}"

state_owner() {
  state_path="$1"
  state_label="$2"
  if [ -L "$state_path" ]; then
    echo "$state_label must not be a symlink: $state_path" >&2
    exit 1
  fi
  if [ "$state_label" = "profile" ]; then
    [ -d "$state_path" ] || {
      echo "$state_label must be an existing directory: $state_path" >&2
      exit 1
    }
  else
    [ -f "$state_path" ] || {
      echo "$state_label must be an existing regular file: $state_path" >&2
      exit 1
    }
  fi
  owner=$(stat -c '%u:%g' -- "$state_path") || {
    echo "cannot determine $state_label owner: $state_path" >&2
    exit 1
  }
  case "$owner" in
    ''|*[!0-9:]*|*:*:*)
      echo "invalid $state_label owner: $owner" >&2
      exit 1
      ;;
  esac
  owner_uid=${owner%%:*}
  owner_gid=${owner#*:}
  case "$owner_uid:$owner_gid" in
    0:*|*:0)
      echo "$state_label owner must be non-root: $owner" >&2
      exit 1
      ;;
  esac
  printf '%s' "$owner"
}

profile_owner=$(state_owner "$REDDIT_PROFILE_DIR" profile)
cookie_owner=$(state_owner "$REDDIT_COOKIE_FILE" cookie)
[ "$profile_owner" = "$cookie_owner" ] || {
  echo "Reddit state ownership mismatch: profile=$profile_owner cookie=$cookie_owner" >&2
  exit 1
}
state_uid=${profile_owner%%:*}
state_gid=${profile_owner#*:}

# Drop every capability, including the bounding set, before starting the
# runtime. Node, yt-dlp, Python, and Chromium consequently cannot flush or
# replace these rules if an upstream payload compromises one of them.
command -v setpriv >/dev/null 2>&1 || {
  echo "setpriv is required to drop CAP_NET_ADMIN" >&2
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
