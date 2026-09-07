#!/bin/sh
# Ask the assigned proxy to open a connection to an operator LAN address and
# report whether it agreed to.
#
# This exists because of one residual hole in the design: root inside the
# desktop shares this namespace's uids, so it can setuid to the redsocks uid and
# talk to PROXY_HOST directly, bypassing the local rule that keeps redsocks from
# ever being asked for a private destination. What stops that from reaching the
# LAN is the proxy's OWN access control, which lives on the proxy boxes
# (10.30.20.71 / .154 / .189) — see docs/EGRESS.md. This probe is the smoke test
# that the ACL is actually in place, run from the exact uid an attacker would
# use.
#
# Usage: vortex-probe-lan <host:port> [<host:port> ...]
# Exit 0 = every target was refused (good). Exit 1 = at least one was reachable.
# Prints one line per target.
#
# Limitation, stated plainly: "refused" is inferred from curl failing. If the
# probe target itself is down, a proxy with NO acl also looks refused. Pick
# targets that are reliably up (the Proxmox UI is), and treat the manual checks
# in docs/EGRESS.md as the authoritative test of the ACL.
set -u
PROXY_HOST="${PROXY_HOST:?}"
PROXY_TYPE="${PROXY_TYPE:-socks5}"
SOCKS_PORT="${SOCKS_PORT:-1080}"
HTTP_PORT="${HTTP_PORT:-3128}"
TIMEOUT="${LAN_PROBE_TIMEOUT:-6}"
RS_UID="$(id -u redsocks)"

probe() {
  if [ "$PROXY_TYPE" = "socks5" ]; then
    setpriv --reuid="$RS_UID" --regid="$RS_UID" --clear-groups \
      curl -sS -k -o /dev/null --max-time "$TIMEOUT" -w '%{http_code}' \
           --socks5-hostname "${PROXY_HOST}:${SOCKS_PORT}" "https://$1/" 2>&1
  else
    setpriv --reuid="$RS_UID" --regid="$RS_UID" --clear-groups \
      curl -sS -k -o /dev/null --max-time "$TIMEOUT" -w '%{http_code}' \
           --proxy "http://${PROXY_HOST}:${HTTP_PORT}" "https://$1/" 2>&1
  fi
}

rc=0
for target in "$@"; do
  [ -n "$target" ] || continue
  out="$(probe "$target")"
  cerr=$?
  if [ "$cerr" -eq 0 ]; then
    echo "REACHABLE ${target} (http_code=${out})"
    rc=1
  else
    echo "refused ${target} (curl exit ${cerr}: $(echo "$out" | tr '\n' ' ' | cut -c1-120))"
  fi
done
exit "$rc"
