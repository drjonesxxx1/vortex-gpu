#!/usr/bin/env python3
"""
VORTEX_GPU — Linux Host Node Agent (v4 — Ubuntu-session provisioning + enforced egress)
Target: Ubuntu (nightmare .128, RTX 4080 SUPER 16GB)

Spawns in-browser Ubuntu desktop sessions, each with the 4080 attached (--gpus all):
  - provision_ubuntu : start a per-session network sidecar that owns the netns and
                       confines egress to the assigned operator VPN proxy, verify
                       through it that the session's egress is NOT the operator's
                       own address, and only then docker run the Ubuntu LXDE
                       desktop attached to that netns with NET_ADMIN dropped.
                       Fails closed: no verified tunnel, no desktop.
  - destroy_ubuntu   : docker rm -f the desktop and its sidecar.
  - shell / hashcat / comfyui : run an arbitrary command against the local GPU.

Egress model (details and threat model in docs/EGRESS.md):
  v3 injected HTTP_PROXY/ALL_PROXY env vars and nothing else. A tenant has root
  in the container, so `unset http_proxy` defeated that instantly, and it never
  covered DNS, ICMP, raw sockets or anything statically linked. There was also
  no --network flag, so the container sat on the default bridge with a working
  route to the operator's LAN (Proxmox, BTCPay, Home Assistant, Jellyfin).
  v4 keeps the env vars (they are the convenience path for cooperating apps and
  the operator wants them) but they are no longer load-bearing: the enforcement
  is iptables inside a namespace the tenant cannot administer.

Auth: X-Node-Secret header (matches server.ts nodeAuthorized).
Runs as a systemd service: vortex-node-agent.service
"""
import ipaddress
import json
import os
import re
import socket
import subprocess
import time
import urllib.parse
import urllib.request

GATEWAY  = os.environ.get("VORTEX_GATEWAY", "http://10.30.20.127:3000")
SECRET   = os.environ.get("VORTEX_NODE_SECRET", "")
if not SECRET:
    raise SystemExit("VORTEX_NODE_SECRET is required; refusing to start with a baked-in default")
INTERVAL = int(os.environ.get("VORTEX_INTERVAL", "5"))
HOSTNAME = socket.gethostname()

SESSION_IMAGE = os.environ.get("VORTEX_SESSION_IMAGE", "dorowu/ubuntu-desktop-lxde-vnc:latest")
HOME = os.path.expanduser("~")
INSTANCE_DIR = os.path.join(HOME, "vortex-agent", "instances")

# ---- Egress enforcement configuration ---------------------------------------
# Built locally on this node from node-agent/sidecar (see docs/EGRESS.md).
SIDECAR_IMAGE = os.environ.get("VORTEX_SIDECAR_IMAGE", "vortex-egress-sidecar:1.0.0")
# The gateway hands out the proxies' HTTP port (http://10.30.20.71:3128). The
# same boxes run SOCKS5 on 1080, which is what the transparent redirector wants:
# SOCKS5 carries arbitrary TCP, HTTP CONNECT is usually restricted to 443.
SOCKS_PORT = int(os.environ.get("VORTEX_SOCKS_PORT", "1080"))
# Refuse to start a session with no assigned proxy. The gateway already refuses,
# but the node must not depend on the gateway having got it right.
REQUIRE_TUNNEL = os.environ.get("VORTEX_REQUIRE_TUNNEL", "1") != "0"
# Egress echo used for the pre-flight proof. Must be fetched THROUGH the tunnel.
EGRESS_CHECK_URL = os.environ.get("VORTEX_EGRESS_CHECK_URL", "https://api.ipify.org")
EGRESS_CHECK_TRIES = int(os.environ.get("VORTEX_EGRESS_CHECK_TRIES", "8"))
EGRESS_CHECK_TIMEOUT = int(os.environ.get("VORTEX_EGRESS_CHECK_TIMEOUT", "12"))
# Addresses that must NEVER be a session's egress. The operator's WAN address is
# the whole point of this exercise; keep it in env so a WAN change is a config
# change, but ship the current value as the default so a missing env var fails
# safe rather than open.
FORBIDDEN_EGRESS = set(
    x.strip() for x in os.environ.get("VORTEX_FORBIDDEN_EGRESS", "203.0.113.10").split(",") if x.strip())
# The proxy boxes sit ON the LAN, so a tenant who impersonates the redsocks uid
# could ask them to open a LAN address. That is stopped on the proxy, not here;
# this probe checks the proxy-side ACL exists before we hand a tenant a session.
REQUIRE_PROXY_LAN_DENY = os.environ.get("VORTEX_REQUIRE_PROXY_LAN_DENY", "1") != "0"
LAN_PROBE_TARGETS = [x.strip() for x in os.environ.get(
    "VORTEX_LAN_PROBE_TARGETS", "10.30.20.85:8006").split(",") if x.strip()]
# Public resolvers for the session. Their addresses barely matter — DNS is
# intercepted and tunnelled regardless — but pointing at a LAN resolver would
# just produce a session that cannot resolve anything.
SESSION_DNS = [x.strip() for x in os.environ.get("VORTEX_DNS", "1.1.1.1,9.9.9.9").split(",") if x.strip()]
# Re-verify live sessions; a proxy box whose VPN drops keeps serving traffic
# (observed failure mode) and would otherwise silently egress the home IP.
EGRESS_WATCHDOG = os.environ.get("VORTEX_EGRESS_WATCHDOG", "1") != "0"
EGRESS_RECHECK_S = int(os.environ.get("VORTEX_EGRESS_RECHECK_S", "120"))
EGRESS_STRIKES = int(os.environ.get("VORTEX_EGRESS_STRIKES", "2"))

IP_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}$")


def http(method, path, body=None):
    req = urllib.request.Request(GATEWAY + path, method=method)
    req.add_header("X-Node-Secret", SECRET)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data=data, timeout=60) as r:
        return json.loads(r.read().decode())


def gpu_info():
    try:
        out = subprocess.run(
            ["nvidia-smi",
             "--query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        return None
    if not out:
        return None
    p = [x.strip() for x in out.split(",")]
    if len(p) < 6:
        return None
    try:
        return {"gpuModel": p[0], "driverVersion": p[1], "memTotalMb": int(p[2]),
                "memUsedMb": int(p[3]), "gpuUtilPct": int(p[4]), "tempC": int(p[5])}
    except ValueError:
        return None


def _procstat():
    with open("/proc/stat") as f:
        fields = f.readline().split()[1:]
    idle = int(fields[3]) + int(fields[4])
    total = sum(int(x) for x in fields)
    return idle, total


def cpu_util():
    try:
        i1, t1 = _procstat()
        time.sleep(0.2)
        i2, t2 = _procstat()
        if t2 == t1:
            return 0
        return int(100 * (1 - (i2 - i1) / (t2 - t1)))
    except Exception:
        return 0


def ram_info():
    mem = {}
    with open("/proc/meminfo") as f:
        for line in f:
            if ":" in line:
                k = line.split(":")[0]
                v = line.split(":")[1].strip().split()[0]
                mem[k] = int(v)
    total_gb = round(mem["MemTotal"] / 1024 / 1024, 1)
    avail_gb = round(mem.get("MemAvailable", 0) / 1024 / 1024, 1)
    return total_gb, round(total_gb - avail_gb, 1)


def uptime_sec():
    return int(float(open("/proc/uptime").read().split()[0]))


def _docker(args, timeout=180):
    return subprocess.run(["docker"] + args, capture_output=True, text=True, timeout=timeout)


def _docker_exec(name, argv, timeout=60):
    return _docker(["exec", name] + argv, timeout=timeout)


def run_shell(command):
    try:
        r = subprocess.run(["bash", "-c", command], capture_output=True, text=True, timeout=600)
        return (r.returncode == 0), (r.stdout or "") + (r.stderr or "")
    except Exception as e:
        return False, f"error: {e}"


# ---- Egress helpers ---------------------------------------------------------

def parse_proxy(proxy):
    """('10.30.20.71', 3128) from 'http://10.30.20.71:3128'. None if unusable.

    The gateway's own parser (parseProxyEndpoints in server.ts) normalises to
    scheme://host:port, so this only has to cope with what that emits.
    """
    if not proxy:
        return None
    try:
        u = urllib.parse.urlparse(proxy)
    except Exception:
        return None
    if not u.hostname:
        return None
    scheme = (u.scheme or "http").lower()
    default = 1080 if scheme.startswith("socks") else 3128
    return u.hostname, int(u.port or default), scheme


def egress_verdict(ip):
    """(ok, reason) for an address claimed to be a session's egress."""
    ip = (ip or "").strip()
    if not IP_RE.match(ip):
        return False, f"egress echo returned no usable address ({ip[:80]!r})"
    if ip in FORBIDDEN_EGRESS:
        return False, f"egress is {ip}, the operator's own address — the VPN on the proxy box is DOWN"
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False, f"egress {ip} is not a valid address"
    if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved or addr.is_unspecified:
        return False, f"egress is {ip}, a non-public address — traffic is not leaving through the tunnel"
    return True, ip


def verify_egress(net_name, tries=1):
    """Fetch the egress echo from INSIDE the session's netns. (ok, ip_or_error).

    This is the whole fail-closed guarantee, so it is deliberately end-to-end:
    the request resolves a hostname (exercising the intercepted DNS path) and
    completes TLS through redsocks (exercising the transparent redirect). A
    partially-configured sidecar cannot pass it.
    """
    last = "no attempt made"
    for i in range(max(1, tries)):
        r = _docker_exec(net_name, ["vortex-verify", EGRESS_CHECK_URL, str(EGRESS_CHECK_TIMEOUT)],
                         timeout=EGRESS_CHECK_TIMEOUT + 10)
        if r.returncode == 0:
            ok, reason = egress_verdict(r.stdout)
            if ok or "operator's own address" in reason or "non-public" in reason:
                return ok, reason
            last = reason
        else:
            last = f"egress check failed: {(r.stderr or r.stdout).strip()[:160]}"
        time.sleep(2 + i)
    return False, last


def probe_proxy_lan_deny(net_name):
    """(denied, detail) — does the assigned proxy refuse operator LAN targets?"""
    if not LAN_PROBE_TARGETS:
        return True, "no targets configured"
    r = _docker_exec(net_name, ["vortex-probe-lan"] + LAN_PROBE_TARGETS, timeout=60)
    detail = ((r.stdout or "") + (r.stderr or "")).strip().replace("\n", "; ")[:300]
    return (r.returncode == 0), detail


def write_resolv_conf(instance_id):
    d = os.path.join(INSTANCE_DIR, instance_id)
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, "resolv.conf")
    with open(p, "w") as f:
        f.write("# VortexGPU session resolver. Queries are intercepted by the egress\n"
                "# sidecar and tunnelled over TCP through the assigned proxy.\n")
        for ns in SESSION_DNS:
            f.write(f"nameserver {ns}\n")
        f.write("options timeout:2 attempts:2\n")
    return p


def start_sidecar(instance_id, port, host, socks_port, http_port, proxy_type):
    """Start the netns-owning sidecar. Returns (ok, name, detail)."""
    name = f"vortex-net-{instance_id}"
    _docker(["rm", "-f", name], timeout=30)
    args = ["run", "-d", "--name", name,
            "--cap-add", "NET_ADMIN", "--cap-add", "NET_RAW",
            "--restart", "no",
            "--label", "vortex.role=sidecar",
            "--label", f"vortex.instance={instance_id}",
            # The published port lives HERE, not on the desktop: the desktop has
            # no network stack of its own to publish from. Docker DNATs the host
            # port into this namespace, the desktop's websockify listens on :80
            # inside it, and the sidecar's INPUT rule accepts that one flow.
            "-p", f"{port}:80",
            "-e", f"PROXY_HOST={host}",
            "-e", f"PROXY_TYPE={proxy_type}",
            "-e", f"SOCKS_PORT={socks_port}",
            "-e", f"HTTP_PORT={http_port}",
            "-e", "INBOUND_PORT=80",
            "-e", f"PROXY_CHECK_URL={EGRESS_CHECK_URL}"]
    for ns in SESSION_DNS:
        args += ["--dns", ns]
    args.append(SIDECAR_IMAGE)
    r = _docker(args)
    if r.returncode != 0:
        return False, name, r.stderr.strip()[:300]
    return True, name, r.stdout.strip()[:12]


def sidecar_logs(name, lines=12):
    r = _docker(["logs", "--tail", str(lines), name], timeout=20)
    return ((r.stdout or "") + (r.stderr or "")).strip().replace("\n", "; ")[:300]


def teardown(instance_id):
    _docker(["rm", "-f", f"vortex-{instance_id}"], timeout=30)
    _docker(["rm", "-f", f"vortex-net-{instance_id}"], timeout=30)


def provision_ubuntu(instance_id, port, password, resolution, proxy=None):
    """Spawn an Ubuntu desktop session behind a verified, enforced egress tunnel.

    Order matters and is the fail-closed contract: sidecar first, tunnel proved
    second, desktop only third. A tenant never gets a shell in a namespace whose
    egress has not been shown to be a VPN exit.
    """
    name = f"vortex-{instance_id}"
    teardown(instance_id)  # clean any stale instance (desktop AND sidecar)

    parsed = parse_proxy(proxy)
    if not parsed:
        if REQUIRE_TUNNEL:
            return False, ("failed: no clean egress proxy was assigned to this session and "
                           "VORTEX_REQUIRE_TUNNEL is on — refusing to start an unproxied desktop")
        return False, "failed: no egress proxy assigned"
    host, pport, scheme = parsed
    http_port = pport if not scheme.startswith("socks") else 3128
    socks_port = pport if scheme.startswith("socks") else SOCKS_PORT

    # SOCKS5 first (carries any TCP port); fall back to the proxy's HTTP CONNECT
    # port if the SOCKS listener is not answering. Both are *proved* by the same
    # end-to-end check below, so the fallback cannot quietly downgrade us into an
    # unverified state.
    net_name = None
    attempts = []
    for proxy_type, verify_tries in (("socks5", EGRESS_CHECK_TRIES), ("http-connect", 4)):
        ok, net_name, detail = start_sidecar(instance_id, port, host, socks_port, http_port, proxy_type)
        if not ok:
            attempts.append(f"{proxy_type}: sidecar would not start ({detail})")
            continue
        ok, reason = verify_egress(net_name, tries=verify_tries)
        if ok:
            egress_ip = reason
            break
        attempts.append(f"{proxy_type}: {reason}")
        print(f"[vortex-agent] {instance_id}: {proxy_type} tunnel unusable: {reason} | "
              f"sidecar: {sidecar_logs(net_name)}", flush=True)
        _docker(["rm", "-f", net_name], timeout=30)
        net_name = None
    else:
        teardown(instance_id)
        return False, "failed: no verified egress tunnel — " + " | ".join(attempts)

    denied, detail = probe_proxy_lan_deny(net_name)
    if not denied:
        print(f"[vortex-agent] {instance_id}: proxy {host} is willing to open operator LAN "
              f"addresses ({detail})", flush=True)
        if REQUIRE_PROXY_LAN_DENY:
            teardown(instance_id)
            return False, (f"failed: proxy {host} has no LAN deny ACL ({detail}) — a root tenant could "
                           f"use it to reach the operator LAN; refusing to start. Fix the proxy ACL "
                           f"(docs/EGRESS.md) or set VORTEX_REQUIRE_PROXY_LAN_DENY=0 to accept the risk")

    resolv = write_resolv_conf(instance_id)
    # Belt (env vars, honoured by cooperating apps) alongside the braces (the
    # namespace rules). These point at the sidecar's local tinyproxy rather than
    # straight at the operator proxy: the operator proxy's address is on the LAN
    # and the firewall denies the desktop's uids direct access to it, so an env
    # var naming it would break every app that honoured it.
    local_proxy = "http://127.0.0.1:3128"
    args = ["run", "-d", "--gpus", "all", "--name", name,
            # Share the sidecar's namespace. NOTE: no -p here — the port is
            # published by the sidecar, which owns the stack.
            "--network", f"container:{net_name}",
            # Root inside here must not be able to rewrite the rules confining
            # it, nor open raw sockets.
            "--cap-drop", "NET_ADMIN", "--cap-drop", "NET_RAW",
            "--security-opt", "no-new-privileges",
            "--label", f"vortex.instance={instance_id}",
            # --dns is rejected in container network mode, so the resolver is
            # bind-mounted instead.
            "-v", f"{resolv}:/etc/resolv.conf:ro",
            "-e", f"VNC_PASSWORD={password}",
            "-e", f"RESOLUTION={resolution or '1440x900'}",
            "-e", f"HTTP_PROXY={local_proxy}", "-e", f"http_proxy={local_proxy}",
            "-e", f"HTTPS_PROXY={local_proxy}", "-e", f"https_proxy={local_proxy}",
            "-e", f"ALL_PROXY={local_proxy}", "-e", f"all_proxy={local_proxy}",
            "-e", "NO_PROXY=localhost,127.0.0.1", "-e", "no_proxy=localhost,127.0.0.1"]
    args.append(SESSION_IMAGE)
    r = _docker(args)
    if r.returncode != 0:
        teardown(instance_id)
        return False, f"failed: {r.stderr.strip()[:400]}"
    cid = r.stdout.strip()[:12]
    return True, (f"launched container={name} id={cid} port={port} proxy={proxy} "
                  f"egress={egress_ip} netns={net_name} enforced=yes")


def destroy_ubuntu(instance_id):
    name = f"vortex-{instance_id}"
    # Desktop first: Docker refuses to remove a namespace owner while a joined
    # container still exists.
    r = _docker(["rm", "-f", name], timeout=30)
    rn = _docker(["rm", "-f", f"vortex-net-{instance_id}"], timeout=30)
    _egress_strikes.pop(instance_id, None)
    out = (r.stdout.strip() or f"removed {name}")
    if rn.returncode == 0:
        out += f" + vortex-net-{instance_id}"
    return True, out


# ---- Egress watchdog --------------------------------------------------------
# The observed failure mode is a proxy box whose VPN drops while its listener
# keeps accepting connections and serving the operator's home IP. Verification at
# spawn time cannot catch that happening mid-session, so re-prove it.
_egress_strikes = {}
_last_recheck = 0.0


def live_sidecars():
    r = _docker(["ps", "--filter", "label=vortex.role=sidecar", "--format", "{{.Names}}"], timeout=30)
    if r.returncode != 0:
        return []
    return [n.strip() for n in r.stdout.splitlines() if n.strip().startswith("vortex-net-")]


def egress_watchdog():
    global _last_recheck
    if not EGRESS_WATCHDOG or time.time() - _last_recheck < EGRESS_RECHECK_S:
        return
    _last_recheck = time.time()
    for net_name in live_sidecars():
        instance_id = net_name[len("vortex-net-"):]
        ok, reason = verify_egress(net_name, tries=2)
        if ok:
            if _egress_strikes.pop(instance_id, 0):
                print(f"[vortex-agent] {instance_id}: egress healthy again ({reason})", flush=True)
            continue
        n = _egress_strikes.get(instance_id, 0) + 1
        _egress_strikes[instance_id] = n
        print(f"[vortex-agent] {instance_id}: EGRESS CHECK FAILED ({n}/{EGRESS_STRIKES}): {reason}",
              flush=True)
        if n >= EGRESS_STRIKES:
            print(f"[vortex-agent] {instance_id}: tearing the session down — a session must never "
                  f"keep running with an unproven egress", flush=True)
            teardown(instance_id)
            _egress_strikes.pop(instance_id, None)


def handle_job(job):
    kind = job.get("kind")
    cmd = job.get("command", "")
    payload = job.get("payload", {}) or {}
    if kind in ("shell", "hashcat", "comfyui"):
        ok, result = run_shell(cmd)
    elif kind == "provision_ubuntu":
        ok, result = provision_ubuntu(payload.get("instanceId", "inst"),
                                      int(payload.get("port", 6090)),
                                      payload.get("password", "vortex"),
                                      payload.get("resolution", "1440x900"),
                                      payload.get("proxy"))
    elif kind == "destroy_ubuntu":
        ok, result = destroy_ubuntu(payload.get("instanceId", ""))
    else:
        ok, result = False, f"unknown job kind: {kind}"
    try:
        http("POST", f"/api/node/jobs/{job['id']}/result", {"ok": ok, "result": result})
    except Exception as e:
        print(f"[vortex-agent] result post failed: {e}", flush=True)


def preflight():
    """Loudly refuse to look healthy if the sidecar image is missing."""
    r = _docker(["image", "inspect", SIDECAR_IMAGE], timeout=30)
    if r.returncode != 0:
        print(f"[vortex-agent] WARNING: sidecar image {SIDECAR_IMAGE} is not present — every "
              f"provision_ubuntu will fail closed until it is built (docs/EGRESS.md)", flush=True)
    else:
        print(f"[vortex-agent] sidecar image {SIDECAR_IMAGE} present", flush=True)


def main():
    g = gpu_info()
    ram_t, _ = ram_info()
    print(f"[vortex-agent] registering node '{HOSTNAME}' with {GATEWAY} ...", flush=True)
    try:
        http("POST", "/api/node/register", {
            "hostname": HOSTNAME,
            "gpuModel": g["gpuModel"] if g else "GPU",
            "driverVersion": g["driverVersion"] if g else "",
            "memTotalMb": g["memTotalMb"] if g else 0,
            "ramTotalGb": ram_t,
        })
        print(f"[vortex-agent] registered. GPU: {g['gpuModel'] if g else '?'}", flush=True)
    except Exception as e:
        print(f"[vortex-agent] register failed: {e}", flush=True)

    preflight()
    print("[vortex-agent] agent active.", flush=True)
    while True:
        g = gpu_info()
        ram_t, ram_u = ram_info()
        cpu = cpu_util()
        up = uptime_sec()
        try:
            http("POST", "/api/node/report", {
                "hostname": HOSTNAME,
                "gpuModel": g["gpuModel"] if g else "GPU",
                "driverVersion": g["driverVersion"] if g else "",
                "memTotalMb": g["memTotalMb"] if g else 0,
                "memUsedMb": g["memUsedMb"] if g else 0,
                "gpuUtilPct": g["gpuUtilPct"] if g else 0,
                "tempC": g["tempC"] if g else 0,
                "cpuUtilPct": cpu, "ramTotalGb": ram_t, "ramUsedGb": ram_u,
                "uptimeSec": up,
            })
        except Exception as e:
            print(f"[vortex-agent] heartbeat dropped: {e}", flush=True)

        try:
            resp = http("GET", f"/api/node/jobs?hostname={HOSTNAME}")
            for job in resp.get("jobs", []):
                print(f"[vortex-agent] job {job.get('id')} kind={job.get('kind')}", flush=True)
                handle_job(job)
        except Exception:
            pass

        try:
            egress_watchdog()
        except Exception as e:
            print(f"[vortex-agent] egress watchdog error: {e}", flush=True)

        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
