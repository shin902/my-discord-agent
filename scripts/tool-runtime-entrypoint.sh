#!/bin/sh
set -eu

# The runtime needs public egress, but must not become a bridge into the host or
# private networks. Docker's embedded DNS is the one loopback exception. Replies
# to the published localhost port are established traffic and must be allowed.
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT || true
iptables -A OUTPUT -d 127.0.0.11 -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -d 127.0.0.11 -p tcp --dport 53 -j ACCEPT
for cidr in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
  iptables -A OUTPUT -d "$cidr" -j REJECT
 done
for cidr in ::1/128 fc00::/7 fe80::/10 fec0::/10 ff00::/8; do
  ip6tables -A OUTPUT -d "$cidr" -j REJECT || true
done
exec "$@"
