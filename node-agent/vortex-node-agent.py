#!/usr/bin/env python3
"""
VORTEX_GPU — Linux Host Node Agent (v3 — Ubuntu-session provisioning + clean proxy)
Target: Ubuntu (nightmare .128, RTX 4080 SUPER 16GB)

Spawns in-browser Ubuntu desktop sessions, each with the 4080 attached (--gpus all):
  - provision_ubuntu : docker run a full Ubuntu LXDE desktop (noVNC) with GPU, on a
                       dedicated port. Tenant gets a clean private machine; the physical
                       GPU is shared/hidden. If a clean ProxyFly proxy is supplied, its
                       address is injected as HTTP(S)_PROXY / ALL_PROXY env vars so the
                       session egresses through a clean residential IP automatically.
  - destroy_ubuntu   : docker rm -f the session container.
  - shell / hashcat / comfyui : run an arbitrary command against the local GPU.

Auth: X-Node-Secret header (matches server.ts nodeAuthorized).
Runs as a systemd service: vortex-node-agent.service
"""
import json
import os
import socket
import subprocess
import time
import urllib.request

GATEWAY  = os.environ.get("VORTEX_GATEWAY", "http://10.30.20.127:3000")
SECRET   = os.environ.get("VORTEX_NODE_SECRET", "<set-VORTEX_NODE_SECRET-in-the-environment>")
INTERVAL = int(os.environ.get("VORTEX_INTERVAL", "5"))
HOSTNAME = socket.gethostname()

SESSION_IMAGE = os.environ.get("VORTEX_SESSION_IMAGE", "dorowu/ubuntu-desktop-lxde-vnc:latest")
HOME = os.path.expanduser("~")


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


def run_shell(command):
    try:
        r = subprocess.run(["bash", "-c", command], capture_output=True, text=True, timeout=600)
        return (r.returncode == 0), (r.stdout or "") + (r.stderr or "")
    except Exception as e:
        return False, f"error: {e}"


def provision_ubuntu(instance_id, port, password, resolution, proxy=None):
    """Spawn a full Ubuntu desktop session with the 4080 attached (noVNC on mapped port).

    If a clean proxy string is supplied (e.g. http://1.2.3.4:8080), it is injected as
    HTTP_PROXY/HTTPS_PROXY/ALL_PROXY env vars so outbound traffic egresses through it.
    """
    name = f"vortex-{instance_id}"
    _docker(["rm", "-f", name], timeout=30)  # clean any stale instance
    args = ["run", "-d", "--gpus", "all", "--name", name,
            "-p", f"{port}:80",
            "-e", f"VNC_PASSWORD={password}",
            "-e", f"RESOLUTION={resolution or '1440x900'}"]
    if proxy:
        args += ["-e", f"HTTP_PROXY={proxy}", "-e", f"http_proxy={proxy}",
                 "-e", f"HTTPS_PROXY={proxy}", "-e", f"https_proxy={proxy}",
                 "-e", f"ALL_PROXY={proxy}", "-e", f"all_proxy={proxy}",
                 "-e", "NO_PROXY=localhost,127.0.0.1"]
    args.append(SESSION_IMAGE)
    r = _docker(args)
    if r.returncode == 0:
        cid = r.stdout.strip()[:12]
        prox = f" proxy={proxy}" if proxy else " proxy=none"
        return True, f"launched container={name} id={cid} port={port}{prox}"
    return False, f"failed: {r.stderr.strip()[:400]}"


def destroy_ubuntu(instance_id):
    name = f"vortex-{instance_id}"
    r = _docker(["rm", "-f", name], timeout=30)
    return True, (r.stdout.strip() or f"removed {name}")


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

        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
