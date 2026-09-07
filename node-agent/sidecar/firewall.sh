#!/bin/sh
# VortexGPU session egress policy. Installed by the sidecar entrypoint into the
# network namespace the tenant desktop is attached to.
#
# Split out of entrypoint.sh so that node-agent/tests/ruleset-netns-test.sh can
# run this exact file in a throwaway namespace and assert on the counters. The
# rules are the security control; they should not be testable only in production.
#
# Env: PROXY_HOST, UPSTREAM_PORT, HTTP_PORT, RS_UID, TP_UID,
#      INBOUND_PORT, REDSOCKS_PORT, DNSTC_PORT
#
# Policy:
#   * OUTPUT policy DROP — no ICMP, no UDP except intercepted DNS, no raw
#     sockets to anywhere, nothing on any port we did not name.
#   * TCP to public addresses is REDIRECTed into redsocks and leaves through the
#     assigned operator VPN proxy.
#   * RFC1918/CGNAT/link-local is DROPPED and deliberately NOT redirected: if it
#     were redirected, redsocks would ask the operator's proxy box to open it,
#     and that box is on the LAN.
#   * UDP/53 (to any nameserver, LAN ones included) is REDIRECTed to redsocks'
#     dnstc responder, which answers TC=1; resolvers retry over TCP/53 and are
#     tunnelled. A resolver that ignores TC fails to resolve — fail closed.
#   * INPUT accepts the published noVNC port so the gateway's reverse proxy
#     still reaches the desktop.
set -eu

PROXY_HOST="${PROXY_HOST:?}"
UPSTREAM_PORT="${UPSTREAM_PORT:?}"
HTTP_PORT="${HTTP_PORT:-3128}"
RS_UID="${RS_UID:?}"
TP_UID="${TP_UID:-$RS_UID}"
INBOUND_PORT="${INBOUND_PORT:-80}"
REDSOCKS_PORT="${REDSOCKS_PORT:-12345}"
DNSTC_PORT="${DNSTC_PORT:-5300}"

# 10/8 covers the operator LAN (10.30.20.0/24: Proxmox .85, BTCPay .140, Home
# Assistant, Jellyfin). 172.16/12 covers the Docker bridges on nightmare itself.
PRIVATE_NETS="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4"

ipt() { iptables "$@"; }

# IPv6: off entirely. Docker's default bridge has no IPv6 on nightmare today,
# but a tenant must not benefit if that ever changes.
if command -v ip6tables >/dev/null 2>&1; then
  ip6tables -F 2>/dev/null || true
  ip6tables -t nat -F 2>/dev/null || true
  for c in INPUT OUTPUT FORWARD; do ip6tables -P "$c" DROP 2>/dev/null || true; done
  ip6tables -A INPUT  -i lo -j ACCEPT 2>/dev/null || true
  ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
fi

ipt -t nat -F
ipt -F
ipt -P FORWARD DROP

# --- nat OUTPUT: transparent redirection -------------------------------------
ipt -t nat -N VORTEX_TCP
# redsocks' and tinyproxy's own upstream connections must not be redirected back
# into redsocks.
ipt -t nat -A VORTEX_TCP -m owner --uid-owner "$RS_UID" -j RETURN
[ "$TP_UID" = "$RS_UID" ] || ipt -t nat -A VORTEX_TCP -m owner --uid-owner "$TP_UID" -j RETURN
ipt -t nat -A VORTEX_TCP -d 127.0.0.0/8 -j RETURN
for net in $PRIVATE_NETS; do
  ipt -t nat -A VORTEX_TCP -d "$net" -j RETURN
done
ipt -t nat -A VORTEX_TCP -p tcp -j REDIRECT --to-ports "$REDSOCKS_PORT"
ipt -t nat -A OUTPUT -p tcp -j VORTEX_TCP

ipt -t nat -A OUTPUT -p udp --dport 53 -m owner ! --uid-owner "$RS_UID" \
    -j REDIRECT --to-ports "$DNSTC_PORT"

# --- filter INPUT ------------------------------------------------------------
ipt -A INPUT -i lo -j ACCEPT
ipt -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# noVNC: the gateway reverse-proxies to <node_ip>:<published port>, which Docker
# DNATs into this namespace. This is the one inbound flow that must survive.
ipt -A INPUT -p tcp --dport "$INBOUND_PORT" -j ACCEPT
ipt -P INPUT DROP

# --- filter OUTPUT -----------------------------------------------------------
ipt -A OUTPUT -o lo -j ACCEPT
# Packets the nat chain above just REDIRECTed now carry dst 127.0.0.1, but the
# filter chain still sees the ORIGINAL output interface (verified: without this
# rule every redirected packet hits the OUTPUT policy DROP and the session has
# no egress at all). Match on the rewritten destination instead of on `-o lo`.
ipt -A OUTPUT -d 127.0.0.0/8 -j ACCEPT
# Replies on established flows — notably the inbound noVNC connection, whose
# peer is the Docker bridge address in 172.17/16 — must be accepted before the
# private-network DROP below.
ipt -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# The tunnel itself, and only it.
ipt -A OUTPUT -p tcp -d "$PROXY_HOST" --dport "$UPSTREAM_PORT" \
    -m owner --uid-owner "$RS_UID" -j ACCEPT
[ "$TP_UID" = "$RS_UID" ] || ipt -A OUTPUT -p tcp -d "$PROXY_HOST" --dport "$HTTP_PORT" \
    -m owner --uid-owner "$TP_UID" -j ACCEPT
# Named explicitly so `iptables -L OUTPUT -v` shows an operator which network a
# session tried to touch.
for net in $PRIVATE_NETS; do
  ipt -A OUTPUT -d "$net" -j DROP
done
ipt -P OUTPUT DROP
