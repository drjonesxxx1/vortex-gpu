# Session egress enforcement

How a VortexGPU GPU session is prevented from using — or learning — the
operator's home IP, and from touching the operator's LAN.

Scope: the Ubuntu GPU sessions on `nightmare` (10.30.20.128) only. The Proxmox
KVM guests are a different provisioning path and are **not** covered here.

Source: `node-agent/` in this repo. Nothing in this document is live until a
human runs the deployment steps below.

---

## 1. What we are defending against

The tenant has **root inside the session container**, by design — that is the
product. So the threat model is "root in a container we handed them", not
"a curious user".

| # | Threat | Old outcome (v3, live today) |
|---|---|---|
| T1 | Tenant reads the operator's home IP (`curl ifconfig.me`) | **Leaked.** Env-var proxy is defeated by `unset http_proxy`; anything not honouring env vars never used it at all. |
| T2 | Tenant scans the operator LAN (Proxmox `10.30.20.85`, BTCPay `10.30.20.140`, Home Assistant, Jellyfin) | **Fully reachable.** No `--network` flag, so the container sat on the default bridge with a working route to `10.30.20.0/24`. |
| T3 | DNS leak — queries go to the operator's resolver / the ISP sees them | **Leaked.** Env-var proxies never covered DNS. |
| T4 | ICMP / traceroute / raw sockets reveal the upstream path | **Leaked.** Nothing intercepted them. |
| T5 | Non-cooperating clients (torrent, statically linked binaries, most GUI apps, QUIC) | **Leaked.** Env vars are advisory. |
| T6 | The exit's VPN drops mid-session while its proxy keeps serving | **Leaked.** Observed today: all three exits dropped VPN simultaneously and kept accepting connections while serving `203.0.113.10`. They fail **open**. |
| T7 | Tenant reaches the LAN *through* the proxy box (the proxies are themselves on `10.30.20.0/24`) | **Reachable.** |

The operator's imperative, verbatim: *the home IP must never be used on any
spawned machine.*

## 2. Design

Three containers' worth of responsibility, two containers per session:

```
                       gateway 10.30.20.127
                              │  reverse-proxies /session/<id>/
                              ▼      to http://10.30.20.128:<port>
    ┌───────────────── nightmare (10.30.20.128) ─────────────────┐
    │                                                            │
    │   docker -p <port>:80                                      │
    │        │                                                   │
    │        ▼                                                   │
    │   ┌── vortex-net-<id> (sidecar) ──────────────────────┐     │
    │   │  OWNS THE NETWORK NAMESPACE. CAP_NET_ADMIN.       │     │
    │   │   • iptables: OUTPUT policy DROP                  │     │
    │   │   • redsocks  → SOCKS5 on the assigned VPN box    │─────┼──▶ 10.30.20.71:1080
    │   │   • dnstc     → forces DNS over TCP into redsocks │     │    (VPN exit, rotating)
    │   │   • tinyproxy → 127.0.0.1:3128 for HTTP_PROXY     │     │
    │   │                                                   │     │
    │   │  ┌── vortex-<id> (desktop) ──────────────────┐    │     │
    │   │  │  --network=container:vortex-net-<id>      │    │     │
    │   │  │  --cap-drop NET_ADMIN --cap-drop NET_RAW  │    │     │
    │   │  │  --gpus all, noVNC on :80 in this netns   │    │     │
    │   │  │  TENANT IS ROOT IN HERE                   │    │     │
    │   │  └───────────────────────────────────────────┘    │     │
    │   └───────────────────────────────────────────────────┘     │
    └────────────────────────────────────────────────────────────┘
```

### Why root in the desktop cannot get out of it

* **The rules live in a namespace the tenant cannot administer.** The desktop
  joins the sidecar's netns but is started with `--cap-drop NET_ADMIN`. A
  capability that is not in the bounding set cannot be regained by root, so
  `iptables`, `ip route`, `ip link` and friends fail inside the desktop. The
  only process with `CAP_NET_ADMIN` in that namespace is the sidecar's
  entrypoint, which the tenant has no way to reach (separate mount namespace,
  separate PID namespace, no shared filesystem).
* **Default deny, not default allow.** `OUTPUT` policy is `DROP`. Anything the
  policy does not explicitly name — ICMP, UDP other than DNS, QUIC, raw
  sockets, every port we did not think of — has no rule to match and is
  dropped. This is the single highest-value rule in the design.
* **The LAN is dropped explicitly**, `10/8` `172.16/12` `192.168/16`
  `169.254/16` `100.64/10` `224/4` `240/4`, as hit-counted rules so an operator
  can see attempts with `iptables -L OUTPUT -v`.
* **Private destinations are never handed to the proxy.** They `RETURN` from
  the nat chain rather than being redirected, so redsocks is never asked to
  open a LAN address on the tenant's behalf.
* **DNS cannot leak.** `udp/53` to *any* nameserver — including a LAN resolver
  a tenant sets by hand in `/etc/resolv.conf` — is redirected to redsocks'
  `dnstc` responder, which answers `TC=1`. Resolvers then retry over `tcp/53`,
  which is redirected into the tunnel like any other TCP. A resolver that
  ignores `TC` simply fails to resolve. Failing to resolve is the safe
  direction.
* **Fail closed at spawn.** The desktop container is not created until an
  egress-IP echo has been fetched *through the tunnel from inside the sidecar*
  and the answer is a public address that is neither `203.0.113.10` nor
  RFC1918. No assigned proxy, or no verified tunnel → the job returns `ok:false`
  and the gateway marks the session `failed`. The tenant never gets a shell in
  an unproven namespace.
* **Fail closed during the session.** The agent re-proves egress every
  `VORTEX_EGRESS_RECHECK_S` (120s) and destroys the session after
  `VORTEX_EGRESS_STRIKES` (2) consecutive failures. This is aimed squarely at
  T6, the fail-open exit boxes.

### The belt as well as the braces

`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` are still injected, as the operator
wants. They now point at `http://127.0.0.1:3128` — the sidecar's tinyproxy,
whose upstream is the assigned operator proxy — **not** at the operator proxy
directly. Pointing them at `http://10.30.20.71:3128` would be worse than
useless: that address is denied to the desktop's uids by the firewall, so every
cooperating app would break while non-cooperating apps carried on working
through the transparent path. The env vars are now a convenience, not a
control; deleting them changes nothing about what a tenant can reach.

### What preserves inbound noVNC — the part most likely to break

The gateway reverse-proxies `/session/<instanceId>/` (HTTP **and** the
websocket upgrade) to `http://<node_ip>:<port>`, so that port must stay
reachable from `10.30.20.127` while egress is confined. Three things make that
work, and all three are load-bearing:

1. **`-p <port>:80` moves to the sidecar.** A container in
   `--network=container:` mode has no network stack of its own and Docker
   refuses to publish ports on it. The sidecar owns the stack, so it publishes
   the port; the desktop's websockify binds `:80` *inside that same namespace*,
   so the published port lands on it exactly as before. From the gateway's side
   nothing changed: same node IP, same port, same path.
2. **`INPUT -p tcp --dport 80 -j ACCEPT`.** `INPUT` policy is `DROP`, so the
   inbound flow needs an explicit rule. Docker DNATs the host port into the
   namespace; this is the one inbound flow permitted.
3. **`OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT` sits above
   the RFC1918 DROPs.** Reply packets on the noVNC connection are addressed to
   the Docker bridge peer in `172.17/16`, which the private-network rules would
   otherwise drop. Ordering here is the difference between a working desktop and
   a black screen. Keep it.

Consequences to be aware of:
* The sidecar has **no restart policy** (`--restart no`) on purpose. If Docker
  restarted it, it would build a *new* namespace while the desktop stayed
  attached to the old, dead one — a session that looks alive and has no
  network. Instead, if redsocks dies the sidecar exits, the namespace goes with
  it, and the watchdog reaps the pair.
* `destroy_ubuntu` removes the **desktop first**, then the sidecar: Docker
  refuses to remove a namespace owner while a joined container still exists.

### Deliberate functional losses

State these to tenants rather than letting them discover them:

* **No UDP egress at all** except DNS. QUIC/HTTP3, WireGuard, most game
  traffic, VoIP and UDP torrent do not work. Browsers fall back to TCP for
  HTTP3; most other things do not.
* **No ICMP.** `ping` and `traceroute` fail from inside a session. This is the
  intended behaviour, not a bug report.
* **No LAN, including no other session.** Sessions cannot see each other.
* Throughput and latency are bounded by the assigned VPN box.

## 3. Residual risk — read this before you call it done

**A root tenant can setuid to the redsocks uid.** The rule permitting the
tunnel is `-m owner --uid-owner <redsocks>`, and root inside the desktop shares
the namespace's uid space, so it can `setuid()` to that uid and open a direct
connection to `10.30.20.71:1080`. It cannot reach anything else that way — every
other destination is still dropped — but it *can* speak SOCKS5 to the proxy and
ask it for an arbitrary destination, and the proxy sits on the LAN.

This is closed **on the proxy boxes, not on the node**, and that ACL is a
required part of this deployment (step 2 below). The node refuses to spawn
until a probe from that exact uid confirms the ACL is there
(`VORTEX_REQUIRE_PROXY_LAN_DENY=1`).

Note what this residual risk is *not*: it does not leak the home IP. Traffic
taking that path still exits through the proxy box's VPN. The exposure is LAN
reachability, and only while the proxy ACL is missing.

Other honest caveats:

* The LAN-deny probe infers "refused" from curl failing. If the probe target is
  itself down, a proxy with no ACL also looks refused. Verify the ACL by hand
  (§7) rather than trusting the probe alone.
* If the proxy's SOCKS5 listener refuses `tcp/53`, DNS through the tunnel
  fails and, correctly, no session starts. Check §7.4 first when spawns start
  failing.
* Egress verification is a point-in-time proof plus a 2-minute re-check. A VPN
  that drops and recovers inside one window is not caught.
* IPv6 is disabled inside the namespace rather than tunnelled. If Docker on
  `nightmare` ever gets IPv6 on the default bridge, sessions still have none.

## 4. Deployment on `nightmare`

Deploy in this order. Steps 1–2 are prerequisites; the node fails closed
without them, which means **no sessions spawn** until they are done.

### Step 1 — preload netfilter modules on the host

A container cannot autoload kernel modules, and `nightmare` currently has
`xt_owner` and `xt_REDIRECT` unloaded. Without them the sidecar's rule
installation fails and every spawn fails closed.

```bash
ssh drjones@10.30.20.128
sudo tee /etc/modules-load.d/vortex-egress.conf >/dev/null <<'EOF'
nf_nat
iptable_nat
iptable_filter
xt_owner
xt_REDIRECT
xt_conntrack
xt_tcpudp
EOF
sudo modprobe nf_nat iptable_nat iptable_filter xt_owner xt_REDIRECT xt_conntrack xt_tcpudp
lsmod | grep -E 'xt_owner|xt_REDIRECT'      # both must be listed
```

### Step 2 — deny RFC1918 on each proxy box (required, see §3)

On **each** of `10.30.20.71`, `10.30.20.154`, `10.30.20.189`.

Squid (the `:3128` listener) — put the deny above any allow:

```
acl vortex_forbidden dst 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 127.0.0.0/8
http_access deny vortex_forbidden
http_access deny CONNECT !SSL_ports
```

Dante (the `:1080` SOCKS5 listener) — a deny rule before the permissive one:

```
socks block {
    from: 0.0.0.0/0 to: 10.0.0.0/8
    log: connect error
}
socks block { from: 0.0.0.0/0 to: 172.16.0.0/12 }
socks block { from: 0.0.0.0/0 to: 192.168.0.0/16 }
socks block { from: 0.0.0.0/0 to: 169.254.0.0/16 }
socks block { from: 0.0.0.0/0 to: 127.0.0.0/8 }
socks pass  { from: 10.30.20.0/24 to: 0.0.0.0/0 }
```

Reload each service and confirm with §7.5. Also confirm the SOCKS5 listener
actually accepts `tcp/53` and arbitrary ports, or DNS through the tunnel will
not work.

### Step 3 — build the sidecar image on the node

```bash
# from a checkout of this repo on nightmare, or copy node-agent/sidecar across
cd node-agent/sidecar
docker build -t vortex-egress-sidecar:1.0.0 .
docker images --digests vortex-egress-sidecar     # record the digest in the change log
```

Base image is `debian:bookworm-slim`; packages are `redsocks`, `tinyproxy`,
`iptables`, `curl`, `ca-certificates`, `util-linux`, `iproute2`. The image is
built locally rather than pulled from a third-party "redsocks" image on purpose:
the entire security property rests on this container's contents.

### Step 4 — install the agent

```bash
ssh drjones@10.30.20.128
cp /home/drjones/vortex-agent/vortex-node-agent.py \
   /home/drjones/vortex-agent/vortex-node-agent.py.bak-$(date +%Y%m%d)
# copy node-agent/vortex-node-agent.py from the repo into place
sudo systemctl restart vortex-node-agent.service
journalctl -u vortex-node-agent.service -n 30 --no-pager
```

Expect `sidecar image vortex-egress-sidecar:1.0.0 present` in the log. If it
says `WARNING: ... not present`, go back to step 3 — every spawn will fail
closed until it is there.

### Step 5 — first live session, watched

Spawn one session from the console and, before handing anything to a tenant,
run §7 inside it. Watch the agent log while it happens:

```bash
journalctl -u vortex-node-agent.service -f
```

A healthy provision logs a result of the form:

```
launched container=vortex-<id> id=<cid> port=<port> proxy=http://10.30.20.71:3128 \
  egress=144.48.39.29 netns=vortex-net-<id> enforced=yes
```

## 5. Configuration

All optional; the defaults are the intended production settings.

| Env var | Default | Meaning |
|---|---|---|
| `VORTEX_SIDECAR_IMAGE` | `vortex-egress-sidecar:1.0.0` | Sidecar image tag. |
| `VORTEX_SOCKS_PORT` | `1080` | SOCKS5 port on the proxy boxes. The gateway hands out the `:3128` HTTP URL; SOCKS5 is preferred for the transparent leg because HTTP CONNECT is usually restricted to 443. |
| `VORTEX_REQUIRE_TUNNEL` | `1` | Refuse to spawn without an assigned proxy. |
| `VORTEX_FORBIDDEN_EGRESS` | `203.0.113.10` | Addresses that must never be a session's egress. |
| `VORTEX_EGRESS_CHECK_URL` | `https://api.ipify.org` | Echo used for the proof. |
| `VORTEX_REQUIRE_PROXY_LAN_DENY` | `1` | Refuse to spawn if the proxy will open LAN addresses (§3). |
| `VORTEX_LAN_PROBE_TARGETS` | `10.30.20.85:8006` | What the probe tries to reach through the proxy. |
| `VORTEX_EGRESS_WATCHDOG` | `1` | Re-prove egress on live sessions. |
| `VORTEX_EGRESS_RECHECK_S` | `120` | How often. |
| `VORTEX_EGRESS_STRIKES` | `2` | Consecutive failures before the session is destroyed. |
| `VORTEX_DNS` | `1.1.1.1,9.9.9.9` | Resolvers written into the session's `/etc/resolv.conf`. Queries are intercepted regardless. |

Set them in the systemd unit (`Environment=`), not in the script.

## 6. Rollback

The change is confined to one Python file plus an image. Nothing in the
gateway, the database or the job protocol changed, so rollback is local to the
node.

```bash
ssh drjones@10.30.20.128
# stop taking new work is not necessary — just put the old agent back
cp /home/drjones/vortex-agent/vortex-node-agent.py.bak-<date> \
   /home/drjones/vortex-agent/vortex-node-agent.py
sudo systemctl restart vortex-node-agent.service
# sessions started under the new agent keep running; to clear them:
docker ps --filter label=vortex.role=sidecar --format '{{.Names}}'
docker rm -f vortex-<id> vortex-net-<id>     # desktop FIRST, then the sidecar
```

Rolling back restores the v3 behaviour, which means **sessions egress from the
home IP again if a proxy's VPN is down, and can reach the LAN**. Prefer
narrowing a check to rolling the whole thing back:

* Proxy has no LAN ACL yet and you accept the risk: `VORTEX_REQUIRE_PROXY_LAN_DENY=0`.
* Watchdog is too aggressive for a flaky exit: `VORTEX_EGRESS_WATCHDOG=0`.
* Never set `VORTEX_REQUIRE_TUNNEL=0`. That is the rule the operator's
  imperative is made of.

The image can be dropped with `docker rmi vortex-egress-sidecar:1.0.0` once no
session uses it.

## 7. Verification — run these INSIDE a live session

Open the session's noVNC desktop, start a terminal (you are root), and run
each of these. Every one of them is a claim a tenant could otherwise disprove.

Reference values: operator WAN `203.0.113.10`; operator LAN `10.30.20.0/24`
(Proxmox `.85:8006`, BTCPay `.140`, gateway `.127`, node `.128`); known VPN
exits observed `187.40.248.39`, `186.247.39.18`, `144.48.39.29`.

### 7.1 The egress is a VPN exit, and is not the home IP

```bash
curl -s https://api.ipify.org; echo
curl -s https://ifconfig.co/json | head -20      # second, independent echo
```
**Pass:** a public address, the same on both, and not `203.0.113.10`. Cross-check
it against the `egress=` value in the agent's `launched container=…` log line
for this instance, which was measured through the same tunnel before the
desktop started.
**Fail:** `203.0.113.10`, or two different answers (split routing).

### 7.2 The operator LAN is unreachable

```bash
for h in 10.30.20.85 10.30.20.140 10.30.20.127 10.30.20.128 10.30.20.71 172.17.0.1 192.168.1.1; do
  timeout 3 bash -c "echo > /dev/tcp/$h/80" 2>&1 | tail -1
  echo "  ^ $h"
done
curl -sk --max-time 5 https://10.30.20.85:8006/ ; echo "exit=$?"   # Proxmox UI
timeout 5 nmap -Pn -p 8006,80,443 10.30.20.85 2>/dev/null | tail -6
```
**Pass:** every connection times out; curl exit is 28 (or 7); nmap reports
filtered.
**Fail:** any banner, any HTTP status, any open port.

### 7.3 ICMP and raw sockets are dead

```bash
ping -c2 -W2 1.1.1.1        ; echo "exit=$?"
ping -c2 -W2 10.30.20.85    ; echo "exit=$?"
traceroute -m4 1.1.1.1 2>&1 | head
```
**Pass:** ping fails — ideally with `socket: Operation not permitted`
(NET_RAW dropped) and otherwise with 100% loss; traceroute produces nothing
useful.
**Fail:** replies, or a traceroute that shows `10.30.20.1` or any hop before
the VPN exit.

### 7.4 DNS does not leak

```bash
cat /etc/resolv.conf                             # 1.1.1.1 / 9.9.9.9, not a 10.x
dig +short whoami.akamai.net @ns1-1.akamaitech.net   # answers with the resolver's egress
dig +short o-o.myaddr.l.google.com TXT @ns1.google.com
dig +tcp +short example.com                      # tunnelled TCP path, must work
dig +notcp +short example.com                    # UDP path: truncated, then fails
# prove a LAN resolver cannot be used even if a tenant sets one:
echo 'nameserver 10.30.20.1' > /etc/resolv.conf && dig +short example.com; echo "exit=$?"
```
**Pass:** the `whoami` answers show the VPN exit's address, never
`203.0.113.10` and never a `10.30.20.x`; TCP resolution works; the LAN
resolver produces no answer. (Restore `/etc/resolv.conf` afterwards or the
session's own resolution stays broken.)
**Fail:** any answer that reveals the operator's ISP resolver, or resolution
succeeding against `10.30.20.1`.

### 7.5 The proxy itself refuses the LAN (run on the node, not in the session)

This is the check for the residual risk in §3, and the one that proves step 2
was actually applied:

```bash
curl -sk --max-time 6 -o /dev/null -w '%{http_code}\n' \
     --socks5-hostname 10.30.20.71:1080 https://10.30.20.85:8006/
curl -sk --max-time 6 -o /dev/null -w '%{http_code}\n' \
     --proxy http://10.30.20.71:3128 https://10.30.20.85:8006/
```
**Pass:** both fail (curl exit 7/28/56/97, no HTTP status).
**Fail:** an HTTP status code — the ACL is missing, and a root tenant who
setuids to the redsocks uid can reach Proxmox. Fix the proxy before spawning.

### 7.6 The tenant cannot alter the rules confining them

```bash
iptables -L                       # inside the desktop
ip link add dummy0 type dummy
ip route del default
```
**Pass:** all three fail with `Operation not permitted` — `NET_ADMIN` is not in
the bounding set.
**Fail:** any of them succeeding. Stop and treat the session as compromised.

### 7.7 Rules and counters, from the node

```bash
docker exec vortex-net-<id> iptables -L -v -n
docker exec vortex-net-<id> iptables -t nat -L -v -n
docker logs --tail 40 vortex-net-<id>
```
Rising counters on the `10.0.0.0/8 DROP` rule are a tenant probing the LAN and
being stopped. Rising counters are informational, not an incident.

## 8. What is verified, and what is not

Verified on the gateway box (`10.30.20.127`), by running
`node-agent/tests/ruleset-netns-test.sh` — the real `firewall.sh`, in a
throwaway namespace, asserting on netfilter counters:

* The complete ruleset installs cleanly on iptables-nft against a 6.x kernel.
* Connections to `10.30.20.85:8006`, `172.17.0.1`, `192.168.1.1` and
  `169.254.169.254` hit the private-network `DROP` rules.
* A connection to a public address is redirected to the redsocks port **with
  `SO_ORIGINAL_DST` intact** — the mechanism redsocks needs to know where the
  tenant was actually going.
* `udp/53` aimed at a public resolver *and* at a LAN resolver is redirected to
  the local dnstc port.
* The redsocks uid may reach the proxy tuple; another uid attempting the same
  destination is dropped.
* `INPUT`/`OUTPUT` policies are `DROP` and inbound `tcp/80` is accepted.

This test also caught a defect that would have broken every session: after the
nat `REDIRECT`, the filter chain still sees the original output interface, so an
`-o lo` rule does not match and every redirected packet hit the `OUTPUT` policy
`DROP`. Matching the rewritten `127.0.0.0/8` destination fixes it.

Also verified: `python3 node-agent/selftest.py` covers the proxy-URL parsing and
the egress verdict — including that `203.0.113.10`, RFC1918, loopback,
link-local, an empty body and an HTML error page are all refused.

**Not verified — a human must confirm these on `nightmare`:**

* That the sidecar image builds, and that Debian bookworm's `redsocks` `dnstc`
  section behaves as documented (UDP truncation → TCP retry) in practice.
* That `tinyproxy`'s `upstream http` line works against the operator's Squid.
  If it does not, the env-var path degrades and the transparent path still
  covers everything; that is a cosmetic failure, not a security one.
* That the operator's SOCKS5 listeners accept `tcp/53` and arbitrary ports.
  If they do not, sessions fail closed and §7.4 will show why.
* That `docker run -p` on the sidecar plus `--network=container:` on the
  desktop preserves the gateway's noVNC reverse proxy end to end, **including
  the websocket upgrade**. This is the most likely thing to break; it is
  reasoned through in §2 but has not been exercised against a real desktop.
* That `--gpus all` behaves identically in `--network=container:` mode. There is
  no reason it should not — the NVIDIA runtime touches devices, not the network
  stack — but it has not been run.
* Every check in §7. None of them has been run against a live session, because
  doing so would have meant deploying to the live GPU node.
