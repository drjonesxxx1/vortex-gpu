// GPU session admission via HyperSwap, the live VRAM arbitrator.
//
// The gateway no longer answers a busy card with a blunt 503. It asks HyperSwap
// (a read-only HTTP API on the session node) whether the card is available under
// a "wait your turn, never evict active work" policy, and either spawns now,
// parks the request as a 'queued' session for the background promoter, or — when
// HyperSwap is unreachable — falls back to the MIN_FREE_VRAM_MB floor so an
// outage still fails safe.
//
// SAFETY: no test here reaches real HyperSwap, a real GPU node, or the internet.
// A LOCAL stub HTTP server stands in for HyperSwap; the gateway is pointed at it
// with HYPERSWAP_URL. The stub is started at MODULE scope (before any useServer()
// reads the env) and unref()'d so it never holds the test process open. Every
// server uses a throwaway DB on a spare port; ssh is shimmed by the harness.
//
// We cannot reach the real HyperSwap from the test env, so the ETA/median and
// policy assertions below are all driven from stub-controlled data.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { useServer } from "./helpers/harness.js";
import { get, post } from "./helpers/http.js";
import { seedUser, seedSession, getUser, getSession, countSessions } from "./helpers/db.js";

// ---------------------------------------------------------------------------
// stub HyperSwap
// ---------------------------------------------------------------------------

const NOW_S = () => Math.floor(Date.now() / 1000);

// A card sitting idle: no running job, VRAM free, nobody holding it.
function freeState() {
  return {
    gpu: { gpu_util_pct: 2, vram_used_gb: 0.4, vram_free_gb: 15.6, vram_total_gb: 16, temperature_c: 38, available: true },
    tenants: { tenants: [{ name: "vortex", priority: 65, reclaimable: false, holding_gb: 0, busy: {} }] },
    stats: { gpu: {}, arbitrator: { running: true, last_action: "idle", comfy_active: false }, ollama: { loaded_models: [] } },
    jobs: { jobs: [] },
  };
}

// Card free of a running job but ollama has a model parked (idle, reclaimable).
function reclaimableIdleState() {
  const s = freeState();
  s.gpu.vram_used_gb = 14; s.gpu.vram_free_gb = 2;
  s.tenants.tenants.push({ name: "ollama", priority: 50, reclaimable: true, holding_gb: 14, busy: {} });
  s.stats.ollama.loaded_models = [{ name: "llama3", size: 14000000000 }];
  return s;
}

// A comfyui job actively running, with a done-job history that gives a median
// duration of 120s for its model. elapsed ~30s -> etaS ~90s.
function busyRunningState() {
  return {
    gpu: { gpu_util_pct: 96, vram_used_gb: 15.2, vram_free_gb: 0.8, vram_total_gb: 16, temperature_c: 71, available: false },
    tenants: { tenants: [{ name: "comfyui", priority: 60, reclaimable: true, holding_gb: 15, busy: { job: "render" } }] },
    stats: { gpu: {}, arbitrator: { running: true, last_action: "grant comfyui", comfy_active: true }, ollama: { loaded_models: [] } },
    jobs: {
      jobs: [
        { id: "run1", tenant: "comfyui", state: "running", payload: { model: "sdxl" }, started_at: NOW_S() - 30 },
        { id: "done1", tenant: "comfyui", state: "done", payload: { model: "sdxl" }, duration_s: 120, finished_at: NOW_S() - 500 },
        { id: "done2", tenant: "comfyui", state: "done", payload: { model: "sdxl" }, duration_s: 120, finished_at: NOW_S() - 400 },
        { id: "done3", tenant: "comfyui", state: "done", payload: { model: "sdxl" }, duration_s: 120, finished_at: NOW_S() - 300 },
      ],
    },
  };
}

async function startHyperswapStub(initial) {
  const stub = { state: initial, releases: [], hits: 0 };
  const server = http.createServer((req, res) => {
    stub.hits++;
    const url = req.url || "";
    let body = null;
    if (url === "/api/gpu") body = stub.state.gpu;
    else if (url === "/api/tenants") body = stub.state.tenants;
    else if (url === "/api/stats") body = stub.state.stats;
    else if (url === "/api/jobs") body = stub.state.jobs;
    else {
      const m = url.match(/^\/api\/tenants\/([^/]+)\/release$/);
      if (m && req.method === "POST") { stub.releases.push(decodeURIComponent(m[1])); body = { ok: true, released: decodeURIComponent(m[1]) }; }
    }
    if (body === null) { res.writeHead(404); res.end("{}"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref(); // never hold the loop open — node:test drains it before exit
  stub.url = `http://127.0.0.1:${server.address().port}`;
  stub.close = () => new Promise((r) => server.close(r));
  return stub;
}

const stub = await startHyperswapStub(freeState());
process.on("exit", () => { try { stub.close(); } catch { /* closing */ } });

const BASE_ENV = {
  SESSION_NODE: "testnode",
  HYPERSWAP_URL: stub.url,
  HYPERSWAP_CACHE_MS: "0",      // no caching, so a state flip is seen immediately
  REQUIRE_CLEAN_PROXY: "0",     // no proxy pool in tests; do not fail the egress preflight
  MIN_FREE_VRAM_MB: "2048",
  GPU_QUEUE_SWEEP_MS: "300",
};

async function tokenFor(srv, user) {
  const r = await post(srv, "/api/auth/login", { body: { username: user.username, password: user.password } });
  assert.equal(r.status, 200, r.text);
  return r.json.token;
}

// Report the session node so the online check passes. memUsedMb is deliberately
// LOW so the VRAM floor would pass too — proving admission is driven by the
// arbitrator, not by nvidia-smi, whenever HyperSwap is reachable.
function reportNode(srv, fields = {}) {
  return post(srv, "/api/node/report", {
    headers: { "x-node-secret": srv.nodeSecret },
    body: { hostname: "testnode", gpuModel: "TEST 4080", memTotalMb: 16384, memUsedMb: 512, ...fields },
  });
}

async function spawn(srv, token) {
  return post(srv, "/api/session/spawn", { token, body: { resolution: "1440x900" } });
}

// ---------------------------------------------------------------------------

describe("gpu-status: shape from HyperSwap and when unavailable", () => {
  const srv = useServer({ env: BASE_ENV });
  before(async () => { stub.state = freeState(); assert.equal((await reportNode(srv)).status, 200); });

  it("reports source=hyperswap with real numbers when the card is free", async () => {
    stub.state = freeState();
    const r = await get(srv, "/api/gpu-status");
    assert.equal(r.status, 200);
    assert.equal(r.json.source, "hyperswap");
    assert.equal(r.json.available, true);
    assert.equal(r.json.busyPct, 2);
    assert.equal(r.json.vramTotalGb, 16);
    assert.equal(r.json.holder, null);
    assert.equal(r.json.activeJob, null);
    assert.equal(r.json.etaSeconds, 0);
  });

  it("reflects a running job: not available, holder set, real etaSeconds from the median", async () => {
    stub.state = busyRunningState();
    const r = await get(srv, "/api/gpu-status");
    assert.equal(r.json.source, "hyperswap");
    assert.equal(r.json.available, false);
    assert.equal(r.json.holder, "comfyui");
    assert.ok(r.json.activeJob, "an active job is reported");
    assert.equal(r.json.activeJob.model, "sdxl");
    assert.ok(r.json.etaSeconds >= 80 && r.json.etaSeconds <= 90, `etaSeconds ~90, got ${r.json.etaSeconds}`);
    assert.ok(r.json.queueDepth >= 1);
  });

  it("health carries the safe subset (gpuBusyPct + gpuStatus, no IPs/tenant internals)", async () => {
    stub.state = busyRunningState();
    const r = await get(srv, "/api/health");
    assert.equal(r.status, 200);
    assert.equal(typeof r.json.gpuBusyPct, "number");
    assert.equal(r.json.gpuStatus.source, "hyperswap");
    assert.equal(r.json.gpuStatus.holder, "comfyui");
    // No sensitive leakage: the public shape has no tenant list, priorities or IPs.
    assert.equal(r.json.gpuStatus.tenants, undefined);
    assert.equal(JSON.stringify(r.json.gpuStatus).includes("127.0.0.1"), false);
  });
});

describe("spawn: card available -> spawns now", () => {
  const srv = useServer({ env: BASE_ENV });
  let user, token;
  before(async () => {
    stub.state = freeState();
    user = seedUser(srv, { password: "hunter22", balanceMinutes: 600 });
    token = await tokenFor(srv, user);
    assert.equal((await reportNode(srv)).status, 200);
  });

  it("returns 200 provisioning and creates a live session row", async () => {
    stub.state = freeState();
    const r = await spawn(srv, token);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.state, "provisioning");
    assert.ok(r.json.port >= 6090 && r.json.port <= 6190);
    const row = getSession(srv, r.json.id);
    assert.equal(row.state, "provisioning");
  });
});

describe("spawn: idle reclaimable holder -> reclaim then spawn", () => {
  const srv = useServer({ env: BASE_ENV });
  let user, token;
  before(async () => {
    stub.state = reclaimableIdleState();
    stub.releases.length = 0;
    user = seedUser(srv, { password: "hunter22", balanceMinutes: 600 });
    token = await tokenFor(srv, user);
    assert.equal((await reportNode(srv)).status, 200);
  });

  it("asks the idle reclaimable tenant to release, then spawns", async () => {
    const r = await spawn(srv, token);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.state, "provisioning");
    assert.ok(stub.releases.includes("ollama"), `expected an ollama release, got ${JSON.stringify(stub.releases)}`);
  });
});

describe("spawn: running job -> queued, no charge, no dispatch", () => {
  const srv = useServer({ env: BASE_ENV });
  let user, token;
  before(async () => {
    stub.state = busyRunningState();
    user = seedUser(srv, { password: "hunter22", balanceMinutes: 600 });
    token = await tokenFor(srv, user);
    assert.equal((await reportNode(srv)).status, 200);
  });

  it("returns 202 queued with a real etaSeconds and does not charge or dispatch", async () => {
    stub.state = busyRunningState();
    const r = await spawn(srv, token);
    assert.equal(r.status, 202, r.text);
    assert.equal(r.json.state, "queued");
    assert.equal(r.json.holder, "comfyui");
    assert.ok(r.json.etaSeconds >= 80 && r.json.etaSeconds <= 90, `etaSeconds ~90, got ${r.json.etaSeconds}`);

    assert.equal(countSessions(srv, user.id), 1);
    const row = getSession(srv, r.json.id);
    assert.equal(row.state, "queued");
    assert.equal(row.port, 0, "no port reserved while queued (no container dispatched)");
    assert.equal(row.proxy, null);
    assert.equal(getUser(srv, user.id).balance_minutes, 600, "nothing may be charged while queued");
  });

  it("surfaces the queued state with etaSeconds on /api/sessions and /api/me", async () => {
    stub.state = busyRunningState();
    const list = await get(srv, "/api/sessions", { token });
    assert.equal(list.status, 200);
    const q = list.json.find((s) => s.state === "queued");
    assert.ok(q, "queued session present in the bare array");
    assert.ok(q.etaSeconds >= 80 && q.etaSeconds <= 90);
    assert.equal(q.holder, "comfyui");

    const me = await get(srv, "/api/me", { token });
    assert.equal(me.status, 200);
    assert.ok(me.json.sessions.some((s) => s.state === "queued" && s.etaSeconds >= 80 && s.etaSeconds <= 90));
  });
});

describe("promoter: promotes a queued session when the card frees", () => {
  const srv = useServer({ env: BASE_ENV });
  let user, token, queuedId;
  before(async () => {
    stub.state = busyRunningState();
    user = seedUser(srv, { password: "hunter22", balanceMinutes: 600 });
    token = await tokenFor(srv, user);
    assert.equal((await reportNode(srv)).status, 200);
    const r = await spawn(srv, token);
    assert.equal(r.status, 202, r.text);
    queuedId = r.json.id;
  });

  it("flips to provisioning once HyperSwap reports the card available", async () => {
    assert.equal(getSession(srv, queuedId).state, "queued");
    stub.state = freeState(); // the card frees; the promoter should pick it up
    const until = Date.now() + 8000;
    let row;
    for (;;) {
      row = getSession(srv, queuedId);
      if (row.state !== "queued") break;
      if (Date.now() > until) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(row.state, "provisioning", "promoter should have promoted the queued session");
    assert.ok(row.port >= 6090 && row.port <= 6190, "a real port is allocated at promotion");
    assert.equal(getUser(srv, user.id).balance_minutes, 600, "promotion does not charge (billing starts at running)");
  });
});

describe("cap: MAX_GPU_SESSIONS forces a queue even when available", () => {
  const srv = useServer({ env: { ...BASE_ENV, MAX_GPU_SESSIONS: "1" } });
  let user, token;
  before(async () => {
    stub.state = freeState();
    // Another user already occupies the one allowed slot.
    const other = seedUser(srv, {});
    seedSession(srv, { userId: other.id, state: "running" });
    user = seedUser(srv, { password: "hunter22", balanceMinutes: 600 });
    token = await tokenFor(srv, user);
    assert.equal((await reportNode(srv)).status, 200);
  });

  it("queues the spawn because the box is at its concurrency cap", async () => {
    stub.state = freeState();
    const r = await spawn(srv, token);
    assert.equal(r.status, 202, r.text);
    assert.equal(r.json.state, "queued");
  });
});

describe("ttl: a queued session expires to failed if never granted", () => {
  const srv = useServer({ env: { ...BASE_ENV, GPU_QUEUE_TTL_MS: "1200", GPU_QUEUE_SWEEP_MS: "300" } });
  let user, token, queuedId;
  before(async () => {
    stub.state = busyRunningState(); // stays busy: never promotable
    user = seedUser(srv, { password: "hunter22", balanceMinutes: 600 });
    token = await tokenFor(srv, user);
    assert.equal((await reportNode(srv)).status, 200);
    const r = await spawn(srv, token);
    assert.equal(r.status, 202, r.text);
    queuedId = r.json.id;
  });

  it("moves to failed with a reason after the TTL", async () => {
    stub.state = busyRunningState();
    const until = Date.now() + 8000;
    let row;
    for (;;) {
      row = getSession(srv, queuedId);
      if (row.state === "failed") break;
      if (Date.now() > until) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(row.state, "failed", "queued session should have expired");
    assert.ok(row.status_reason && /queued/.test(row.status_reason), `expected a reason, got ${row.status_reason}`);
    assert.equal(getUser(srv, user.id).balance_minutes, 600, "an expired queued session never charged");
  });
});

describe("fallback: HyperSwap unreachable -> MIN_FREE_VRAM_MB floor, never 500", () => {
  // Point at a dead address so every HyperSwap call fails fast.
  const DEAD = { ...BASE_ENV, HYPERSWAP_URL: "http://127.0.0.1:1" };

  describe("ample VRAM -> spawns", () => {
    const srv = useServer({ env: DEAD });
    let user, token;
    before(async () => {
      user = seedUser(srv, { password: "hunter22", balanceMinutes: 600 });
      token = await tokenFor(srv, user);
      assert.equal((await reportNode(srv, { memUsedMb: 512 })).status, 200); // 15.5GB free
    });
    it("gpu-status is source=unavailable with null numbers", async () => {
      const r = await get(srv, "/api/gpu-status");
      assert.equal(r.status, 200);
      assert.equal(r.json.source, "unavailable");
      assert.equal(r.json.busyPct, null);
      assert.equal(r.json.available, false);
    });
    it("spawn passes the VRAM floor and provisions (not a 500)", async () => {
      const r = await spawn(srv, token);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.state, "provisioning");
    });
  });

  describe("scarce VRAM -> 503 capacity floor", () => {
    const srv = useServer({ env: DEAD });
    let user, token;
    before(async () => {
      user = seedUser(srv, { password: "hunter22", balanceMinutes: 600 });
      token = await tokenFor(srv, user);
      assert.equal((await reportNode(srv, { memUsedMb: 16000 })).status, 200); // ~384MB free
    });
    it("refuses on the floor with a real figure, never 500, nothing charged", async () => {
      const r = await spawn(srv, token);
      assert.equal(r.status, 503, r.text);
      assert.match(r.json.error, /capacity/);
      assert.equal(countSessions(srv, user.id), 0);
      assert.equal(getUser(srv, user.id).balance_minutes, 600);
    });
  });
});
