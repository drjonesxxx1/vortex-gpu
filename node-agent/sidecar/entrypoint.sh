#!/bin/sh
# VortexGPU per-session egress sidecar — network namespace owner.
#
# Everything a tenant desktop can send leaves through this namespace. The
# desktop is started with --network=container:<this container> and with
# NET_ADMIN/NET_RAW dropped, so root inside the desktop shares these rules but
# cannot edit them.
#
# Policy, in one paragraph:
#   * OUTPUT policy DROP. No ICMP, no UDP (except DNS, which is intercepted
#     locally), no raw sockets to anywhere, no IPv6 at all.
#   * All TCP to public addresses is REDIRECTed into redsocks, which forwards it
#     over the assigned operator SOCKS5 (or HTTP CONNECT) proxy.
#   * All TCP/UDP to RFC1918, CGNAT and link-local is DROPPED and is *never*
#     handed to redsocks, so the proxy cannot be used as a bridge back onto the
#     operator LAN.
#   * UDP/53 is REDIRECTed to redsocks' dnstc responder, which replies TC=1;
#     resolvers then retry over TCP/53, which is tunnelled like any other TCP.
#     A resolver that ignores TC simply fails to resolve — fail closed.
#   * The only permitted direct egress is redsocks -> PROXY_HOST:SOCKS_PORT and
#     tinyproxy -> PROXY_HOST:HTTP_PORT, matched on uid.
#   * INPUT accepts the published noVNC port so the gateway's reverse proxy
#     still reaches the desktop.
#
# Required env: PROXY_HOST, SOCKS_PORT (or HTTP_PORT with PROXY_TYPE=http-connect)
# Optional env: PROXY_TYPE (socks5|http-connect, default socks5), HTTP_PORT,
#               INBOUND_PORT (default 80), REDSOCKS_PORT, DNSTC_PORT,
#               LOCAL_HTTP_PROXY_PORT
set -eu

PROXY_HOST="${PROXY_HOST:?PROXY_HOST is required}"
PROXY_TYPE="${PROXY_TYPE:-socks5}"
SOCKS_PORT="${SOCKS_PORT:-1080}"
HTTP_PORT="${HTTP_PORT:-3128}"
INBOUND_PORT="${INBOUND_PORT:-80}"
REDSOCKS_PORT="${REDSOCKS_PORT:-12345}"
DNSTC_PORT="${DNSTC_PORT:-5300}"
LOCAL_HTTP_PROXY_PORT="${LOCAL_HTTP_PROXY_PORT:-3128}"

case "$PROXY_TYPE" in
  socks5)       UPSTREAM_PORT="$SOCKS_PORT" ;;
  http-connect) UPSTREAM_PORT="$HTTP_PORT" ;;
  *) echo "sidecar: unsupported PROXY_TYPE=$PROXY_TYPE" >&2; exit 2 ;;
esac

RS_UID="$(id -u redsocks)"
TP_UID="$(id -u tinyproxy 2>/dev/null || echo "$RS_UID")"

# Networks a session must never be able to address. 10/8 covers the operator
# LAN (10.30.20.0/24 — Proxmox, BTCPay, Home Assistant, Jellyfin) and 172.16/12
# covers the Docker bridges on nightmare itself.
PRIVATE_NETS="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4"

log() { echo "[sidecar] $*" >&2; }

# ---------------------------------------------------------------- redsocks ---
cat >/etc/redsocks.conf <<EOF
base {
    log_debug = off;
    log_info = on;
    log = "stderr";
    daemon = off;
    redirector = iptables;
}
redsocks {
    local_ip = 127.0.0.1;
    local_port = ${REDSOCKS_PORT};
    ip = ${PROXY_HOST};
    port = ${UPSTREAM_PORT};
    type = ${PROXY_TYPE};
}
dnstc {
    local_ip = 127.0.0.1;
    local_port = ${DNSTC_PORT};
}
EOF

# --------------------------------------------------------------- tinyproxy ---
# The "belt": HTTP_PROXY/HTTPS_PROXY/ALL_PROXY inside the desktop point here.
# Its upstream is the operator proxy's plain HTTP port. Cooperating apps take
# this path; everything else is caught transparently by redsocks anyway.
cat >/etc/tinyproxy/tinyproxy.conf <<EOF
User tinyproxy
Group tinyproxy
Port ${LOCAL_HTTP_PROXY_PORT}
Listen 127.0.0.1
Timeout 600
LogLevel Warning
LogFile "/dev/stderr"
MaxClients 200
Allow 127.0.0.1
DisableViaHeader Yes
upstream http ${PROXY_HOST}:${HTTP_PORT}
EOF

# ---------------------------------------------------------------- firewall ---
# The policy itself lives in firewall.sh so the same file can be exercised in a
# throwaway namespace by node-agent/tests/ruleset-netns-test.sh. If any rule
# fails to install, `set -e` kills the container here — before redsocks is up and
# therefore before the agent can verify anything, so the session never starts.
PROXY_HOST="$PROXY_HOST" UPSTREAM_PORT="$UPSTREAM_PORT" HTTP_PORT="$HTTP_PORT" \
RS_UID="$RS_UID" TP_UID="$TP_UID" INBOUND_PORT="$INBOUND_PORT" \
REDSOCKS_PORT="$REDSOCKS_PORT" DNSTC_PORT="$DNSTC_PORT" \
  /usr/local/bin/vortex-firewall

log "policy installed: proxy=${PROXY_TYPE}://${PROXY_HOST}:${UPSTREAM_PORT} redsocks_uid=${RS_UID} inbound_tcp=${INBOUND_PORT}"

# ------------------------------------------------------------------- daemons --
# tinyproxy is best-effort: it is the cooperating-app convenience path, not the
# enforcement path. redsocks is the enforcement path and runs in the foreground,
# so if it dies the container dies and the desktop loses its namespace.
if ! tinyproxy -c /etc/tinyproxy/tinyproxy.conf; then
  log "WARNING: tinyproxy failed to start; env-var proxying will be unavailable (transparent redirection is unaffected)"
fi

exec setpriv --reuid="$RS_UID" --regid="$RS_UID" --clear-groups \
     redsocks -c /etc/redsocks.conf
