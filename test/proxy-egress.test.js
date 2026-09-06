// Session egress proxies: the clean-exit preflight on /api/session/spawn.
//
// This product is sold on anonymity. The failure that matters is not "the proxy
// is down" — it is "the proxy is UP and serving the operator's own IP", which is
// exactly what was observed in production when a box's VPN dropped: it kept
// accepting proxy connections and answered with the home address. A health check
// that only asks "did it respond?" calls that healthy. So every test here drives
// the egress VALUE, not just reachability.
//
// SAFETY: no test reaches a real proxy box or the internet. The stub proxies
// below are local, and PROXY_CHECK_URL points at an http:// target so the
// gateway takes its absolute-URI request path straight to a stub. The suite
// passes on a machine with no network.
//
// The stubs are started at module scope, before any describe registers, because
// useServer() reads the env when IT boots — a stub started in a later before()
// hook would not exist yet.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { useServer } from "./helpers/harness.js";
import { get, post } from "./helpers/http.js";
import { seedUser, countSessions, getUser } from "./helpers/db.js";

const HOME_IP = "203.0.113.9";   // stands in for the operator's WAN address
const CLEAN_IP = "198.51.100.7"; // a legitimate VPN exit

/**
 * A stub HTTP proxy answering any absolute-URI GET with `egress` — which is what
 * the gateway's probe reads as the observed exit address.
 */
async function startStubProxy(egress) {
  const stub = { egress, hits: 0 };
  const server = http.createServer((req, res) => {
    stub.hits++;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(stub.egress);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Do NOT hold the event loop open: node:test waits for the loop to drain
  // before the file's process exits, so a live listener hangs the whole run.
  server.unref();
  stub.url = `http://127.0.0.1:${server.address().port}`;
  stub.close = () => new Promise((r) => server.close(r));
  return stub;
}

const cleanProxy = await startStubProxy(CLEAN_IP);
const leakingProxy = await startStubProxy(HOME_IP);
process.on("exit", () => { try { cleanProxy.close(); leakingProxy.close(); } catch { /* closing */ } });

const BASE_ENV = {
  SESSION_NODE: "testnode",
  PROXY_FORBIDDEN_EGRESS: HOME_IP,
  PROXY_CHECK_URL: "http://example.invalid/ip",
  PROXY_REFRESH_MS: "60000",
};

/** Wait until every configured endpoint has been probed at least once. */
async function awaitFirstProbe(srv, deadlineMs = 20000) {
  const until = Date.now() + deadlineMs;
  let last = null;
  while (Date.now() < until) {
    const r = await get(srv, "/api/admin/state", { headers: { authorization: `Bearer ${srv.adminToken}` } });
    if (r.status === 200) {
      last = r.json.proxyPool || [];
      if (last.length && last.every((p) => p.lastChecked > 0)) return last;
    }
    await new Promise((r2) => setTimeout(r2, 150));
  }
  throw new Error(`endpoints never probed: ${JSON.stringify(last)}`);
}

async function tokenFor(srv, user) {
  const r = await post(srv, "/api/auth/login", { body: { username: user.username, password: user.password } });
  assert.equal(r.status, 200, r.text);
  return r.json.token;
}

function reportNode(srv, fields = {}) {
  return post(srv, "/api/node/report", {
    headers: { "x-node-secret": srv.nodeSecret },
    body: { hostname: "testnode", gpuModel: "TEST 4080", memTotalMb: 16384, memUsedMb: 1024, ...fields },
  });
}

// ---------------------------------------------------------------------------

describe("proxy health: a leaking exit is never selected", () => {
  const srv = useServer({
    env: { ...BASE_ENV, REQUIRE_CLEAN_PROXY: "1", PROXY_ENDPOINTS: `${cleanProxy.url},${leakingProxy.url}` },
  });

  it("marks the clean exit healthy and the leaking one unhealthy", async () => {
    const pool = await awaitFirstProbe(srv);
    const cleanEp = pool.find((p) => p.url === cleanProxy.url);
    const leakEp = pool.find((p) => p.url === leakingProxy.url);

    assert.equal(cleanEp.healthy, true, `clean endpoint should be healthy: ${cleanEp.lastError}`);
    assert.equal(cleanEp.egressIp, CLEAN_IP);

    assert.equal(leakEp.healthy, false, "an exit serving the operator's own IP must never be healthy");
    assert.equal(leakEp.reachable, true, "it IS reachable — that is precisely why reachability is not the test");
    assert.equal(leakEp.egressIp, HOME_IP);
    assert.match(leakEp.lastError, /LEAKING/);
  });

  it("only ever hands out the clean exit", async () => {
    await awaitFirstProbe(srv);
    await reportNode(srv);
    const user = seedUser(srv, { password: "hunter22", balanceMinutes: 600 });
    const token = await tokenFor(srv, user);

    const r = await post(srv, "/api/session/spawn", {
      headers: { authorization: `Bearer ${token}` },
      body: { resolution: "1440x900" },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.proxy, cleanProxy.url, "the leaking exit must never be assigned");
  });
});

describe("fail closed: no clean exit means no session", () => {
  const srv = useServer({
    env: { ...BASE_ENV, REQUIRE_CLEAN_PROXY: "1", PROXY_ENDPOINTS: leakingProxy.url },
  });

  it("refuses the spawn with 503, writes no row and charges nothing", async () => {
    await awaitFirstProbe(srv);
    await reportNode(srv);
    const user = seedUser(srv, { password: "hunter22", balanceMinutes: 600 });
    const token = await tokenFor(srv, user);
    const balanceBefore = getUser(srv, user.id).balance_minutes;

    const r = await post(srv, "/api/session/spawn", {
      headers: { authorization: `Bearer ${token}` },
      body: { resolution: "1440x900" },
    });

    assert.equal(r.status, 503, r.text);
    assert.match(r.json.error, /clean egress/i);
    assert.match(r.json.error, /nothing was charged/i);
    assert.equal(countSessions(srv, user.id), 0, "a refused spawn must not leave a session row");
    assert.equal(getUser(srv, user.id).balance_minutes, balanceBefore, "a refused spawn must not charge");
  });
});

describe("fail closed: an unset forbidden list cannot verify anything", () => {
  const srv = useServer({
    env: { ...BASE_ENV, PROXY_FORBIDDEN_EGRESS: "", REQUIRE_CLEAN_PROXY: "1", PROXY_ENDPOINTS: cleanProxy.url },
  });

  it("refuses to call a reachable exit healthy when it cannot be checked", async () => {
    const pool = await awaitFirstProbe(srv);
    assert.equal(pool[0].reachable, true);
    assert.equal(pool[0].healthy, false, "unverifiable must not mean healthy");
    assert.match(pool[0].lastError, /FORBIDDEN_EGRESS is unset/);
  });

  it("and therefore refuses the spawn", async () => {
    await awaitFirstProbe(srv);
    await reportNode(srv);
    const user = seedUser(srv, { password: "hunter22", balanceMinutes: 600 });
    const token = await tokenFor(srv, user);
    const r = await post(srv, "/api/session/spawn", {
      headers: { authorization: `Bearer ${token}` },
      body: { resolution: "1440x900" },
    });
    assert.equal(r.status, 503, r.text);
    assert.equal(countSessions(srv, user.id), 0);
  });
});

describe("REQUIRE_CLEAN_PROXY=0 restores the old un-proxied behaviour", () => {
  const srv = useServer({
    env: { ...BASE_ENV, REQUIRE_CLEAN_PROXY: "0", PROXY_ENDPOINTS: "" },
  });

  it("spawns with a null proxy when the operator has opted out", async () => {
    await reportNode(srv);
    const user = seedUser(srv, { password: "hunter22", balanceMinutes: 600 });
    const token = await tokenFor(srv, user);
    const r = await post(srv, "/api/session/spawn", {
      headers: { authorization: `Bearer ${token}` },
      body: { resolution: "1440x900" },
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.proxy, null, "opted out means no proxy, explicitly");
  });
});

describe("the proxy route still does not leak exit addresses", () => {
  const srv = useServer({
    env: { ...BASE_ENV, REQUIRE_CLEAN_PROXY: "1", PROXY_ENDPOINTS: cleanProxy.url },
  });

  it("requires auth", async () => {
    const r = await get(srv, "/api/proxy/pool");
    assert.equal(r.status, 401);
  });

  it("never returns an egress IP to an authenticated tenant", async () => {
    await awaitFirstProbe(srv);
    const user = seedUser(srv, { password: "hunter22" });
    const token = await tokenFor(srv, user);
    const r = await get(srv, "/api/proxy/pool", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200, r.text);
    assert.ok(!r.text.includes(CLEAN_IP), "an exit address must not reach a tenant");
    assert.ok(!r.text.includes(HOME_IP), "and certainly not the operator's own");
  });

  it("never exposes an egress IP on the anonymous health endpoint", async () => {
    const r = await get(srv, "/api/health");
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes(CLEAN_IP));
    assert.ok(!r.text.includes(HOME_IP));
  });
});
