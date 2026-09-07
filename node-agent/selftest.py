#!/usr/bin/env python3
"""Offline checks for the pure decision logic in vortex-node-agent.py.

Nothing here touches Docker or the network: it exercises the two functions that
decide whether a session is allowed to exist — proxy URL parsing and the egress
verdict — because those are the parts where a silent mistake fails OPEN.

    python3 node-agent/selftest.py
"""
import importlib.util
import os
import sys

os.environ.setdefault("VORTEX_FORBIDDEN_EGRESS", "203.0.113.10")
spec = importlib.util.spec_from_file_location(
    "agent", os.path.join(os.path.dirname(os.path.abspath(__file__)), "vortex-node-agent.py"))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

fails = []


def check(label, got, want):
    if got != want:
        fails.append(f"{label}: got {got!r}, want {want!r}")


# --- parse_proxy -------------------------------------------------------------
check("http proxy", agent.parse_proxy("http://10.30.20.71:3128"), ("10.30.20.71", 3128, "http"))
check("socks proxy", agent.parse_proxy("socks5://10.30.20.154:1080"), ("10.30.20.154", 1080, "socks5"))
check("default http port", agent.parse_proxy("http://10.30.20.189"), ("10.30.20.189", 3128, "http"))
check("default socks port", agent.parse_proxy("socks5h://10.30.20.189"), ("10.30.20.189", 1080, "socks5h"))
check("no proxy", agent.parse_proxy(None), None)
check("empty proxy", agent.parse_proxy(""), None)
check("garbage proxy", agent.parse_proxy("not a url"), None)

# --- egress_verdict: everything below must be REFUSED ------------------------
for bad, why in [
    ("203.0.113.10", "operator WAN"),
    ("10.30.20.128", "operator LAN"),
    ("172.17.0.2", "docker bridge"),
    ("192.168.1.10", "rfc1918"),
    ("127.0.0.1", "loopback"),
    ("169.254.1.1", "link local"),
    ("0.0.0.0", "unspecified"),
    ("", "empty"),
    ("<html>error</html>", "html error page"),
    ("not-an-ip", "garbage"),
    ("999.1.1.1", "out of range octet"),
]:
    ok, _ = agent.egress_verdict(bad)
    check(f"refuse {why} ({bad!r})", ok, False)

# --- egress_verdict: real VPN exits observed today must be ACCEPTED -----------
for good in ("187.40.248.39", "186.247.39.18", "144.48.39.29"):
    check(f"accept {good}", agent.egress_verdict(good), (True, good))

# A whitespace-wrapped echo body (curl output with a trailing newline) is fine.
check("accept trimmed", agent.egress_verdict(" 144.48.39.29\n"), (True, "144.48.39.29"))

if fails:
    print("FAIL\n  " + "\n  ".join(fails))
    sys.exit(1)
print("ok — all egress decision checks passed")
