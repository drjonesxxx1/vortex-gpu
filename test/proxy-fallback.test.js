// Tier 2: the opt-in Proxifly fallback egress pool.
//
// The operator's three VPN boxes dropped their tunnels simultaneously and every
// spawn was refused. Tier 2 exists so that degrades service instead of stopping
// it. What must NOT change is the safety bar, and that is what these tests pin:
//
//   * a tier 2 exit is never handed out while any tier 1 exit is clean;
//   * a tier 2 exit that leaks the operator's own IP is never handed out, even
//     when tier 1 is empty — the fallback is held to the identical probe;
//   * neither tier clean still means 503, no session row, nothing charged;
//   * with PROXY_FALLBACK_ENABLED=0 the source is not even fetched;
//   * a broken source is a logged non-event that leaves the previous pool alone.
//
// SAFETY: nothing here touches the network or the real 10.30.20.x boxes. The
// stub proxies AND the stub fallback-list server are local, and both
// PROXY_CHECK_URL and PROXY_FALLBACK_SOURCE point at them, so the suite passes
// on a machine with no network at all.
//
// Every stub is started at module scope and unref()'d, exactly as in
// proxy-egress.test.js: useServer() reads the env when IT boots, so a stub
// started in a later before() hook would not exist yet, and a live listener
// holding the event loop open would hang the whole run.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { useServer } from "./helpers/harness.js";
import { get, post } from "./helpers/http.js";
import { seedUser, countSessions, getUser } from "./helpers/db.js";

const HOME_IP = "203.0.113.9";    // stands in for the operator's WAN address
const CLEAN_IP = "198.51.100.7";  // a legitimate operator VPN exit
const CLEAN_IP_2 = "198.51.100.8"; // a public fallback exit that is at least not leaking

/** A stub HTTP proxy answering any absolute-URI GET with `egress`. */
async function startStubProxy(egress) {
  const stub = { egress, hits: 0 };
  const server = http.createServer((req, res) => {
    stub.hits++;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(stub.egress);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  stub.url = `http://127.0.0.1:${server.address().port}`;
  stub.close = () => new Promise((r) => server.close(r));
  return stub;
}

const t1Clean = await startStubProxy(CLEAN_IP);
const t1Leaking = await startStubProxy(HOME_IP);
const t2Clean = await startStubProxy(CLEAN_IP_2);
const t2Leaking = await startStubProxy(HOME_IP);

/**
 * The fallback list source. Routed by path so each describe gets its own URL and
 * its own hit counter — no describe can depend on another having run first.
 */
const sourceHits = {};
const routes = {};
const listServer = http.createServer((req, res) => {
  const path = req.url.split("?")[0];
  sourceHits[path] = (sourceHits[path] || 0) + 1;
  const route = routes[path];
  if (!route) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("no such list"); }
  const out = route(sourceHits[path]);
  res.writeHead(out.status, { "Content-Type": out.type || "application/json" });
  res.end(out.body);
});
await new Promise((resolve) => listServer.listen(0, "127.0.0.1", resolve));
listServer.unref();
const LIST_BASE = `http://127.0.0.1:${listServer.address().port}`;

process.on("exit", () => {
  try {
    t1Clean.close(); t1Leaking.close(); t2Clean.close(); t2Leaking.close();
    listServer.close();
  } catch { /* closing */ }
});

/** The Proxifly payload shape: a JSON array of objects carrying `proxy`. */
function proxiflyList(...urls) {
  return JSON.stringify(urls.map((u) => {
    const { hostname, port } = new URL(u);
    return { proxy: u, ip: hostname, port: Number(port), protocol: "http", geolocation: { country: "US" }, anonymity: "elite" };
  }));
}

const BASE_ENV = {
  SESSION_NODE: "testnode",
  PROXY_FORBIDDEN_EGRESS: HOME_IP,
  PROXY_CHECK_URL: "http://example.invalid/ip",
  PROXY_REFRESH_MS: "60000",
  REQUIRE_CLEAN_PROXY: "1",
};

async function adminState(srv) {
  const r = await get(srv, "/api/admin/state", { headers: { authorization: `Bearer ${srv.adminToken}` } });
  assert.equal(r.status, 200, r.text);
  return r.json;
}

/** Poll /api/admin/state until `ok(state)` holds, or fail with what we last saw. */
async function awaitState(srv, ok, what, deadlineMs = 40000) {
  const until = Date.now() + deadlineMs;
  let last = null;
  while (Date.now() < until) {
    last = await adminState(srv);
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify({ pool: last?.proxyPool, egress: last?.egress })}`);
}

/** Tier 1 probed, and (when fallback is on) the first fallback refresh finished. */
const tier1Probed = (st) => st.proxyPool.filter((p) => p.tier === 1).every((p) => p.lastChecked > 0);
const fallbackSettled = (st) => st.egress.fallbackLastRefresh > 0 || !!st.egress.fallbackLastError;

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

async function spawn(srv, token) {
  return post(srv, "/api/session/spawn", {
    headers: { authorization: `Bearer ${token}` },
    body: { resolution: "1440x900" },
  });
}

async function readyTenant(srv) {
  await reportNode(srv);
  const user = seedUser(srv, { password: "hunter22", balanceMinutes: 600 });
  return { user, token: await tokenFor(srv, user) };
}

// ---------------------------------------------------------------------------

describe("tier 1 is exhausted before any fallback exit is used", () => {
  routes["/t1-preferred.json"] = () => ({ status: 200, body: proxiflyList(t2Clean.url) });
  const srv = useServer({
    env: {
      ...BASE_ENV,
      PROXY_ENDPOINTS: t1Clean.url,
      PROXY_FALLBACK_ENABLED: "1",
      PROXY_FALLBACK_SOURCE: `${LIST_BASE}/t1-preferred.json`,
    },
  });

  it("keeps both tiers healthy but hands out only tier 1, repeatedly", async () => {
    const st = await awaitState(srv, (s) => tier1Probed(s) && fallbackSettled(s), "both tiers probed");
    const t1 = st.proxyPool.find((p) => p.url === t1Clean.url);
    const t2 = st.proxyPool.find((p) => p.url === t2Clean.url);

    assert.equal(t1.tier, 1);
    assert.equal(t1.healthy, true, `tier 1 should be healthy: ${t1.lastError}`);
    assert.ok(t2, "the fallback exit should be in the pool");
    assert.equal(t2.tier, 2);
    assert.equal(t2.healthy, true, `and healthy — it is simply not preferred: ${t2.lastError}`);
    assert.equal(st.egress.cleanTier1, 1);
    assert.equal(st.egress.cleanTier2, 1);
    assert.equal(st.egress.servingUntrustedFallback, false, "a clean operator exit exists, so we are not on fallback");

    const { token } = await readyTenant(srv);
    // Repeated spawns: the round-robin must never wander into tier 2. Two, not
    // three — MAX_VMS_PER_USER is 3 and this test is not about the cap.
    for (let i = 0; i < 2; i++) {
      const r = await spawn(srv, token);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.proxy, t1Clean.url, "a healthy tier 2 exit must never displace a healthy tier 1 exit");
    }
  });
});

describe("tier 1 all leaking + fallback enabled: a clean tier 2 exit is used", () => {
  routes["/t2-rescue.json"] = () => ({ status: 200, body: proxiflyList(t2Clean.url) });
  const srv = useServer({
    env: {
      ...BASE_ENV,
      PROXY_ENDPOINTS: t1Leaking.url,
      PROXY_FALLBACK_ENABLED: "1",
      PROXY_FALLBACK_SOURCE: `${LIST_BASE}/t2-rescue.json`,
    },
  });

  it("spawns through the fallback exit and flags the tier in the admin state", async () => {
    const st = await awaitState(srv, (s) => tier1Probed(s) && fallbackSettled(s), "tier 2 refreshed");
    const t1 = st.proxyPool.find((p) => p.url === t1Leaking.url);
    assert.equal(t1.healthy, false, "the operator box is serving the home IP");
    assert.match(t1.lastError, /LEAKING/);
    assert.equal(st.egress.cleanTier1, 0);
    assert.equal(st.egress.cleanTier2, 1);
    assert.equal(st.egress.servingUntrustedFallback, true, "the operator must be able to see they are on untrusted exits");

    const t2 = st.proxyPool.find((p) => p.url === t2Clean.url);
    assert.equal(t2.tier, 2);
    assert.match(t2.tierLabel, /UNTRUSTED/, "the label must not soften what a public proxy is");

    const { token } = await readyTenant(srv);
    const r = await spawn(srv, token);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.proxy, t2Clean.url, "with no clean operator exit, the clean fallback exit is used");
  });
});

describe("a LEAKING fallback exit is never assigned, even with no tier 1 at all", () => {
  routes["/t2-leaking.json"] = () => ({ status: 200, body: proxiflyList(t2Leaking.url) });
  const srv = useServer({
    env: {
      ...BASE_ENV,
      PROXY_ENDPOINTS: "",
      PROXY_FALLBACK_ENABLED: "1",
      PROXY_FALLBACK_SOURCE: `${LIST_BASE}/t2-leaking.json`,
    },
  });

  it("marks it unhealthy for the same reason a leaking operator box is", async () => {
    const st = await awaitState(srv, fallbackSettled, "the fallback refresh");
    const ep = st.proxyPool.find((p) => p.url === t2Leaking.url);
    assert.ok(ep, "the leaking candidate should still be listed, so the operator can see why");
    assert.equal(ep.tier, 2);
    assert.equal(ep.reachable, true, "it IS reachable — reachability is not the test, in either tier");
    assert.equal(ep.healthy, false, "an exit serving the operator's own IP must never be healthy");
    assert.equal(ep.egressIp, HOME_IP);
    assert.match(ep.lastError, /LEAKING/);
    assert.equal(st.egress.cleanTier2, 0);
  });

  it("and refuses the spawn rather than falling back to it", async () => {
    await awaitState(srv, fallbackSettled, "the fallback refresh");
    const { user, token } = await readyTenant(srv);
    const balanceBefore = getUser(srv, user.id).balance_minutes;

    const r = await spawn(srv, token);
    assert.equal(r.status, 503, r.text);
    assert.match(r.json.error, /clean egress/i);
    assert.equal(countSessions(srv, user.id), 0, "a refused spawn must not leave a session row");
    assert.equal(getUser(srv, user.id).balance_minutes, balanceBefore, "a refused spawn must not charge");
  });
});

describe("both tiers unhealthy: still 503, still nothing created or charged", () => {
  routes["/both-bad.json"] = () => ({ status: 200, body: proxiflyList(t2Leaking.url) });
  const srv = useServer({
    env: {
      ...BASE_ENV,
      PROXY_ENDPOINTS: t1Leaking.url,
      PROXY_FALLBACK_ENABLED: "1",
      PROXY_FALLBACK_SOURCE: `${LIST_BASE}/both-bad.json`,
    },
  });

  it("refuses the spawn, writes no row and charges nothing", async () => {
    const st = await awaitState(srv, (s) => tier1Probed(s) && fallbackSettled(s), "both tiers probed");
    assert.equal(st.egress.cleanTier1, 0);
    assert.equal(st.egress.cleanTier2, 0);
    assert.equal(st.egress.servingUntrustedFallback, false, "there is nothing to serve from either tier");

    const { user, token } = await readyTenant(srv);
    const balanceBefore = getUser(srv, user.id).balance_minutes;

    const r = await spawn(srv, token);
    assert.equal(r.status, 503, r.text);
    assert.match(r.json.error, /clean egress/i);
    assert.match(r.json.error, /nothing was charged/i);
    assert.equal(countSessions(srv, user.id), 0);
    assert.equal(getUser(srv, user.id).balance_minutes, balanceBefore);
  });
});

describe("PROXY_FALLBACK_ENABLED=0 means the fallback is never consulted", () => {
  const SOURCE_PATH = "/must-never-be-fetched.json";
  routes[SOURCE_PATH] = () => ({ status: 200, body: proxiflyList(t2Clean.url) });
  const srv = useServer({
    env: {
      ...BASE_ENV,
      PROXY_ENDPOINTS: t1Leaking.url,
      PROXY_FALLBACK_ENABLED: "0",
      PROXY_FALLBACK_SOURCE: `${LIST_BASE}${SOURCE_PATH}`,
    },
  });

  it("does not fetch the source and refuses the spawn even though a clean fallback exists", async () => {
    const st = await awaitState(srv, tier1Probed, "tier 1 probed");
    assert.equal(st.egress.fallbackEnabled, false);
    assert.equal(st.egress.fallbackSource, null, "an opted-out source is not even echoed back");
    assert.equal(st.egress.cleanTier2, 0);
    assert.equal(st.proxyPool.filter((p) => p.tier === 2).length, 0, "no tier 2 rows at all");

    const { user, token } = await readyTenant(srv);
    const r = await spawn(srv, token);
    assert.equal(r.status, 503, r.text);
    assert.equal(countSessions(srv, user.id), 0);

    assert.equal(sourceHits[SOURCE_PATH] || 0, 0, "opting out must mean the list is never fetched");
  });
});

describe("a broken fallback source is a logged non-event", () => {
  routes["/gone.json"] = () => ({ status: 404, body: "not found", type: "text/plain" });
  const srv = useServer({
    env: {
      ...BASE_ENV,
      PROXY_ENDPOINTS: t1Clean.url,
      PROXY_FALLBACK_ENABLED: "1",
      PROXY_FALLBACK_SOURCE: `${LIST_BASE}/gone.json`,
    },
  });

  it("survives a 404, records the error and keeps serving tier 1", async () => {
    const st = await awaitState(srv, (s) => tier1Probed(s) && fallbackSettled(s), "the failed refresh");
    assert.match(st.egress.fallbackLastError, /404/);
    assert.equal(st.egress.fallbackLastRefresh, 0, "a failed refresh is not a refresh");
    assert.equal(st.egress.cleanTier2, 0);

    const { token } = await readyTenant(srv);
    const r = await spawn(srv, token);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.proxy, t1Clean.url, "tier 1 is unaffected by a broken tier 2 source");
    assert.equal((await get(srv, "/api/health")).status, 200, "and the gateway is still up");
  });
});

describe("a fallback source returning garbage does not crash or empty the pool", () => {
  // Good on the first fetch, garbage on every one after it. With the refresh
  // interval at its floor the second pass lands during the test, which is the
  // only way to prove the PREVIOUS pool survives a bad refresh.
  routes["/flip.json"] = (hit) => (hit === 1
    ? { status: 200, body: proxiflyList(t2Clean.url) }
    : { status: 200, body: "<html><body>not json at all</body></html>", type: "text/html" });
  const srv = useServer({
    env: {
      ...BASE_ENV,
      PROXY_ENDPOINTS: "",
      PROXY_FALLBACK_ENABLED: "1",
      PROXY_FALLBACK_SOURCE: `${LIST_BASE}/flip.json`,
      PROXY_REFRESH_MS: "15000", // the server's floor
    },
  });

  it("keeps the previously probed pool and still assigns from it", async () => {
    // First pass: the good list.
    const first = await awaitState(srv, (s) => s.egress.fallbackLastRefresh > 0, "the first good refresh");
    assert.equal(first.egress.cleanTier2, 1);

    // Second pass: garbage. The error is recorded; the pool is not emptied.
    const after = await awaitState(srv, (s) => !!s.egress.fallbackLastError, "the failed second refresh");
    assert.match(after.egress.fallbackLastError, /JSON|usable/i);
    assert.equal(after.egress.cleanTier2, 1, "a bad refresh must leave the previous pool intact");
    assert.ok(after.proxyPool.some((p) => p.url === t2Clean.url && p.healthy));

    const { token } = await readyTenant(srv);
    const r = await spawn(srv, token);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.proxy, t2Clean.url);
  });
});

describe("PROXY_FALLBACK_MAX bounds how much of the list is probed", () => {
  // Five candidates, four of them dead addresses that refuse instantly. Only the
  // first PROXY_FALLBACK_MAX may ever be probed, so a huge upstream list cannot
  // make one refresh outlive its own interval.
  routes["/big.json"] = () => ({
    status: 200,
    body: proxiflyList("http://127.0.0.1:9/", "http://127.0.0.1:1/", t2Clean.url, "http://127.0.0.1:2/", "http://127.0.0.1:3/"),
  });
  const srv = useServer({
    env: {
      ...BASE_ENV,
      PROXY_ENDPOINTS: "",
      PROXY_FALLBACK_ENABLED: "1",
      PROXY_FALLBACK_SOURCE: `${LIST_BASE}/big.json`,
      PROXY_FALLBACK_MAX: "2",
    },
  });

  it("probes only the cap, and the entries past it never enter the pool", async () => {
    const st = await awaitState(srv, fallbackSettled, "the capped refresh");
    const tier2 = st.proxyPool.filter((p) => p.tier === 2);
    assert.equal(tier2.length, 2, `cap of 2 not honoured: ${JSON.stringify(tier2.map((p) => p.url))}`);
    assert.equal(st.egress.fallbackMax, 2);
    assert.ok(!tier2.some((p) => p.url === t2Clean.url), "the third entry is past the cap");
    // Both survivors are dead addresses, so nothing is clean and we fail closed.
    assert.equal(st.egress.cleanTier2, 0);
  });
});

describe("the tier is operator-only: tenants and anonymous callers never see it", () => {
  routes["/leak-check.json"] = () => ({ status: 200, body: proxiflyList(t2Clean.url) });
  const srv = useServer({
    env: {
      ...BASE_ENV,
      PROXY_ENDPOINTS: t1Leaking.url,
      PROXY_FALLBACK_ENABLED: "1",
      PROXY_FALLBACK_SOURCE: `${LIST_BASE}/leak-check.json`,
    },
  });

  it("/api/proxy/pool still needs auth and returns no IP, URL or tier", async () => {
    await awaitState(srv, fallbackSettled, "the fallback refresh");
    assert.equal((await get(srv, "/api/proxy/pool")).status, 401);

    const user = seedUser(srv, { password: "hunter22" });
    const token = await tokenFor(srv, user);
    const r = await get(srv, "/api/proxy/pool", { headers: { authorization: `Bearer ${token}` } });
    assert.equal(r.status, 200, r.text);
    assert.ok(!r.text.includes(CLEAN_IP_2), "a fallback exit address must not reach a tenant");
    assert.ok(!r.text.includes(HOME_IP), "and certainly not the operator's own");
    assert.ok(!r.text.includes(t2Clean.url), "nor the endpoint URL");
    assert.ok(!/tier/i.test(r.text), "which tier is in play is not a tenant's to know");
  });

  it("/api/health exposes counts only — no IP, no URL, no tier, no source", async () => {
    await awaitState(srv, fallbackSettled, "the fallback refresh");
    const r = await get(srv, "/api/health");
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes(CLEAN_IP_2));
    assert.ok(!r.text.includes(HOME_IP));
    assert.ok(!r.text.includes(t2Clean.url));
    assert.ok(!r.text.includes(LIST_BASE), "the fallback source must not be public either");
    assert.ok(!/tier|fallback/i.test(r.text), "no tier signal on the anonymous endpoint");
    assert.equal(typeof r.json.cleanExitsAvailable, "number");
  });

  it("/api/admin/state is 404 without the admin token, tier fields included", async () => {
    const r = await get(srv, "/api/admin/state");
    assert.equal(r.status, 404, "the admin surface stays undiscoverable");
    assert.ok(!r.text.includes(t2Clean.url));
  });
});
