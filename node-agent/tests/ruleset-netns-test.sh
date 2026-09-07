#!/bin/bash
# Exercise node-agent/sidecar/firewall.sh in a throwaway network namespace and
# assert on what it actually does to packets.
#
# This runs the real policy file — not a copy — so a rule that stops working is
# a test failure rather than a production surprise. It needs root and creates
# nothing outside its own namespace: `unshare -n` gives it a private stack whose
# only interfaces are a loopback and a dummy device, and the namespace (with
# every rule in it) disappears when the script exits.
#
#   sudo bash node-agent/tests/ruleset-netns-test.sh
#
# What it can prove here: rule installation, the redirect/RETURN/DROP decisions
# (read from the netfilter counters), and that a public destination genuinely
# lands on the local redsocks port with its original destination intact.
# What it cannot prove here: redsocks, tinyproxy and dnstc behaviour, which need
# the built image and a reachable proxy — see docs/EGRESS.md.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIREWALL="$HERE/../sidecar/firewall.sh"
[ -r "$FIREWALL" ] || { echo "missing $FIREWALL"; exit 2; }

if [ "${VORTEX_NETNS_INNER:-}" != "1" ]; then
  [ "$(id -u)" = "0" ] || { echo "must run as root"; exit 2; }
  exec unshare -n env VORTEX_NETNS_INNER=1 bash "$0" "$@"
fi

RS_UID=65534          # stands in for the redsocks uid
TP_UID=65533          # stands in for the tinyproxy uid
PROXY_HOST=10.30.20.71
UPSTREAM_PORT=1080
REDSOCKS_PORT=12345
DNSTC_PORT=5300

fails=0
ok()   { echo "  ok    $*"; }
bad()  { echo "  FAIL  $*"; fails=$((fails + 1)); }

# A stack with a route, so packets reach the firewall instead of dying at
# "network unreachable" and making every result look like a block.
ip link set lo up
ip link add vnull type dummy
ip addr add 172.17.0.9/16 dev vnull
ip link set vnull up
ip route add default via 172.17.0.1 dev vnull

echo "== installing policy =="
if PROXY_HOST="$PROXY_HOST" UPSTREAM_PORT="$UPSTREAM_PORT" HTTP_PORT=3128 \
   RS_UID="$RS_UID" TP_UID="$TP_UID" INBOUND_PORT=80 \
   REDSOCKS_PORT="$REDSOCKS_PORT" DNSTC_PORT="$DNSTC_PORT" \
   sh "$FIREWALL"; then
  ok "firewall.sh installed cleanly"
else
  bad "firewall.sh failed to install"; echo "FAILURES: $fails"; exit 1
fi

# --- counters ----------------------------------------------------------------
# Packets, not opinions: read the hit count of a specific rule before and after.
count() { # count <table> <chain> <rule-substring>
  iptables -t "$1" -L "$2" -v -n -x 2>/dev/null | grep -- "$3" | head -1 | awk '{print $1}'
}
delta() { # delta <name> <table> <chain> <substring> <command...>
  local label="$1" tbl="$2" chain="$3" sub="$4"; shift 4
  local before after
  before="$(count "$tbl" "$chain" "$sub")"; before="${before:-0}"
  "$@" >/dev/null 2>&1
  after="$(count "$tbl" "$chain" "$sub")"; after="${after:-0}"
  echo $((after - before))
}

connect_as() { # connect_as <uid> <ip> <port> [timeout]
  setpriv --reuid="$1" --regid="$1" --clear-groups \
    python3 - "$2" "$3" "${4:-2}" <<'PY'
import socket, sys
s = socket.socket(); s.settimeout(float(sys.argv[3]))
try: s.connect((sys.argv[1], int(sys.argv[2])))
except Exception: pass
PY
}
udp_to() { # udp_to <ip> <port>
  python3 - "$1" "$2" <<'PY'
import socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try: s.sendto(b"\x00", (sys.argv[1], int(sys.argv[2])))
except Exception: pass
PY
}

echo "== 1. LAN destinations are dropped, and never handed to the proxy =="
d_drop=$(delta lan filter OUTPUT "10.0.0.0/8" connect_as 0 10.30.20.85 8006 1)
[ "$d_drop" -ge 1 ] && ok "root -> 10.30.20.85:8006 hit the 10/8 DROP rule ($d_drop pkt)" \
                   || bad "root -> 10.30.20.85:8006 did not hit the 10/8 DROP rule"

for tgt in 172.17.0.1 192.168.1.1 169.254.169.254; do
  case "$tgt" in
    172.*) sub="172.16.0.0/12" ;; 192.*) sub="192.168.0.0/16" ;; *) sub="169.254.0.0/16" ;;
  esac
  d=$(delta "$tgt" filter OUTPUT "$sub" connect_as 0 "$tgt" 80 1)
  [ "$d" -ge 1 ] && ok "root -> $tgt:80 dropped by $sub" || bad "root -> $tgt:80 NOT dropped by $sub"
done

echo "== 2. public TCP is redirected into redsocks, with the original dst intact =="
python3 - "$REDSOCKS_PORT" <<'PY' &
import socket, struct, sys, time
SO_ORIGINAL_DST = 80
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", int(sys.argv[1]))); srv.listen(4); srv.settimeout(8)
try:
    c, _ = srv.accept()
    raw = c.getsockopt(socket.SOL_IP, SO_ORIGINAL_DST, 16)
    port, = struct.unpack_from("!H", raw, 2)
    ip = socket.inet_ntoa(raw[4:8])
    open("/tmp/vortex-origdst", "w").write(f"{ip}:{port}")
    c.close()
except Exception as e:
    open("/tmp/vortex-origdst", "w").write(f"error: {e}")
PY
listener=$!
sleep 0.7
rm -f /tmp/vortex-origdst
connect_as 0 93.184.216.34 443 2
wait "$listener" 2>/dev/null
got="$(cat /tmp/vortex-origdst 2>/dev/null || echo none)"
[ "$got" = "93.184.216.34:443" ] \
  && ok "root -> 93.184.216.34:443 arrived at redsocks with SO_ORIGINAL_DST=$got" \
  || bad "transparent redirect broken: SO_ORIGINAL_DST was '$got', wanted 93.184.216.34:443"

echo "== 3. the tunnel uid may reach the proxy, other uids may not =="
d_accept=$(delta tunnel filter OUTPUT "owner UID match $RS_UID" connect_as "$RS_UID" "$PROXY_HOST" "$UPSTREAM_PORT" 1)
[ "$d_accept" -ge 1 ] && ok "uid $RS_UID -> $PROXY_HOST:$UPSTREAM_PORT hit the tunnel ACCEPT rule" \
                     || bad "uid $RS_UID -> $PROXY_HOST:$UPSTREAM_PORT did not hit the tunnel ACCEPT rule"
d_deny=$(delta tunnel-other filter OUTPUT "10.0.0.0/8" connect_as 1000 "$PROXY_HOST" "$UPSTREAM_PORT" 1)
[ "$d_deny" -ge 1 ] && ok "uid 1000 -> $PROXY_HOST:$UPSTREAM_PORT was dropped instead" \
                   || bad "uid 1000 -> $PROXY_HOST:$UPSTREAM_PORT was NOT dropped"

echo "== 4. DNS is intercepted wherever it is aimed =="
for ns in 8.8.8.8 10.30.20.1; do
  d=$(delta "dns-$ns" nat OUTPUT "redir ports $DNSTC_PORT" udp_to "$ns" 53)
  [ "$d" -ge 1 ] && ok "udp/53 to $ns was redirected to the local dnstc responder" \
                || bad "udp/53 to $ns was NOT redirected"
done

echo "== 5. ICMP and stray UDP have no path out =="
iptables -S OUTPUT | head -1 | grep -q -- "-P OUTPUT DROP" \
  && ok "OUTPUT policy is DROP (ping, traceroute, raw sockets, QUIC have no rule to match)" \
  || bad "OUTPUT policy is not DROP"
iptables -S INPUT | head -1 | grep -q -- "-P INPUT DROP" \
  && ok "INPUT policy is DROP" || bad "INPUT policy is not DROP"
iptables -S INPUT | grep -q -- "--dport 80 -j ACCEPT" \
  && ok "inbound tcp/80 (noVNC) is accepted — the gateway's reverse proxy still works" \
  || bad "inbound tcp/80 is not accepted; noVNC would break"

echo
if [ "$fails" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "FAILURES: $fails"; fi
exit $((fails > 0))
