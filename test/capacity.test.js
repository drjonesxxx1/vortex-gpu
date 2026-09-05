// GPU session capacity: the /api/session/spawn preflight.
//
// SAFETY: a spawn that gets all the way through inserts a session row and
// enqueues a provision_ubuntu job which a real node agent would turn into a
// real GPU container. No test here reaches that point. The "ample VRAM" case
// below proves the preflight passed by making the *next* step (session port
// allocation) fail deterministically, so the handler returns before it writes a
// row or dispatches a job.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "./helpers/harness.js";
import { get, post } from "./helpers/http.js";
import { seedUser, seedSession, countSessions, getUser } from "./helpers/db.js";

async function tokenFor(srv, user) {
  const r = await post(srv, "/api/auth/login", { body: { username: user.username, password: user.password } });
  assert.equal(r.status, 200, r.text);
  return r.json.token;
}

function reportNode(srv, fields) {
  return post(srv, "/api/node/report", {
    headers: { "x-node-secret": srv.nodeSecret },
    body: { hostname: "testnode", gpuModel: "TEST 4080", memTotalMb: 16384, ...fields },
  });
}

describe("spawn preflight: the session node is not registered", () => {
  const srv = useServer();
  let user, token;

  before(async () => {
    user = seedUser(srv, { password: "hunter22", balanceMinutes: 600 });
    token = await tokenFor(srv, user);
  });

  it("health reports the node offline with no VRAM figures", async () => {
    const r = await get(srv, "/api/health");
    assert.equal(r.json.sessionNode, "testnode");
    assert.equal(r.json.sessionNodeOnline, false);
    assert.equal(r.json.gpuVramFreeMb, 0);
    assert.equal(r.json.gpuNodesOnline, 0);
  });

  it("spawn fails on the node-offline path, not the capacity path", async () => {
    const r = await post(srv, "/api/session/spawn", { token, body: { resolution: "1440x900" } });
    assert.equal(r.status, 503);
    assert.match(r.json.error, /GPU node offline/);
    assert.doesNotMatch(r.json.error, /capacity/);
    assert.equal(countSessions(srv, user.id), 0, "no session row may be created");
    assert.equal(getUser(srv, user.id).balance_minutes, 600, "nothing may be charged");
  });

  it("rejects a bad resolution with 400 before anything else", async () => {
    for (const resolution of ["1440x", "x900", "; rm -rf /", "1440x900; id", "99x99"]) {
      const r = await post(srv, "/api/session/spawn", { token, body: { resolution } });
      assert.equal(r.status, 400, `resolution ${JSON.stringify(resolution)}`);
      assert.match(r.json.error, /1440x900/);
    }
    assert.equal(countSessions(srv, user.id), 0);
  });

  it("requires authentication", async () => {
    assert.equal((await post(srv, "/api/session/spawn", { body: {} })).status, 401);
  });
});

describe("spawn preflight: not enough free VRAM", () => {
  const srv = useServer();
  let user, token;

  before(async () => {
    user = seedUser(srv, { password: "hunter22", balanceMinutes: 600 });
    token = await tokenFor(srv, user);
    // The 4080 SUPER is shared with another workload; this is what the node
    // reports when a large model is resident.
    assert.equal((await reportNode(srv, { memUsedMb: 16000 })).status, 200);
  });

  it("health and the preflight agree on the free figure", async () => {
    const r = await get(srv, "/api/health");
    assert.equal(r.json.sessionNodeOnline, true);
    assert.equal(r.json.gpuVramFreeMb, 384);
    assert.equal(r.json.gpuVramTotalMb, 16384);
    assert.equal(r.json.minFreeVramMb, 2048);
  });

  it("spawn returns 503 with the real figure, creates no session and charges nothing", async () => {
    const before = getUser(srv, user.id).balance_minutes;
    const r = await post(srv, "/api/session/spawn", { token, body: { resolution: "1440x900" } });
    assert.equal(r.status, 503);
    assert.match(r.json.error, /GPU at capacity/);
    assert.match(r.json.error, /384 MiB VRAM free/);
    assert.match(r.json.error, /2048 MiB required/);
    assert.match(r.json.error, /Nothing was charged/);
    assert.equal(countSessions(srv, user.id), 0);
    assert.equal(getUser(srv, user.id).balance_minutes, before);
  });

  it("the refusal is stable — repeating it still creates nothing", async () => {
    for (let i = 0; i < 3; i++) {
      assert.equal((await post(srv, "/api/session/spawn", { token, body: {} })).status, 503);
    }
    assert.equal(countSessions(srv, user.id), 0);
  });
});

describe("spawn preflight: ample free VRAM lets the request through", () => {
  const srv = useServer();
  let user, token, hoarder;

  before(async () => {
    user = seedUser(srv, { password: "hunter22", balanceMinutes: 600 });
    token = await tokenFor(srv, user);
    assert.equal((await reportNode(srv, { memUsedMb: 1000 })).status, 200); // 15384 MiB free

    // Occupy every port in the session range (6090-6190) with LIVE rows
    // belonging to somebody else. allocateSessionPort() runs immediately AFTER
    // the capacity preflight, so its failure proves the preflight passed — while
    // the handler returns before inserting a row or dispatching a provision job.
    // That is how this asserts "past the preflight" without ever starting a
    // container. (Only live states hold a port; a terminal row does not.)
    hoarder = seedUser(srv);
    for (let p = 6090; p <= 6190; p++) seedSession(srv, { userId: hoarder.id, port: p, state: "running" });
  });

  it("health shows the headroom", async () => {
    const r = await get(srv, "/api/health");
    assert.equal(r.json.gpuVramFreeMb, 15384);
    assert.equal(r.json.sessionNodeOnline, true);
  });

  it("gets past the capacity check and fails on port exhaustion instead", async () => {
    const r = await post(srv, "/api/session/spawn", { token, body: { resolution: "1280x720" } });
    assert.equal(r.status, 503);
    assert.match(r.json.error, /no free ports/, "must be the post-preflight failure");
    assert.doesNotMatch(r.json.error, /capacity/, "the VRAM preflight must have passed");
    assert.doesNotMatch(r.json.error, /offline/);
    assert.equal(countSessions(srv, user.id), 0, "no row on a refused spawn");
  });

  it("an exhausted port range never hands out a duplicate port", async () => {
    // The old bug returned 6190 even when it was taken, giving two live sessions
    // the same port. Terminal rows must not reserve a port either — a stopped
    // session holding 6090 forever once broke spawning platform-wide.
    for (let i = 0; i < 3; i++) {
      const r = await post(srv, "/api/session/spawn", { token, body: {} });
      assert.equal(r.status, 503);
      assert.match(r.json.error, /no free ports/);
    }
    assert.equal(countSessions(srv, user.id), 0);
  });
});

describe("spawn preflight: balance and machine caps come first", () => {
  const srv = useServer();
  let broke, brokeToken, rich, richToken;

  before(async () => {
    broke = seedUser(srv, { password: "hunter22", balanceMinutes: 0 });
    brokeToken = await tokenFor(srv, broke);
    rich = seedUser(srv, { password: "hunter22", balanceMinutes: 10_000 });
    richToken = await tokenFor(srv, rich);
    assert.equal((await reportNode(srv, { memUsedMb: 1000 })).status, 200);
  });

  it("402s a zero-balance account that already has its free machine", async () => {
    seedSession(srv, { userId: broke.id, state: "running" });
    const r = await post(srv, "/api/session/spawn", { token: brokeToken, body: {} });
    assert.equal(r.status, 402);
    assert.match(r.json.error, /insufficient balance/);
    assert.equal(countSessions(srv, broke.id), 1, "no extra row");
  });

  it("429s a paying account at the 3-machine cap", async () => {
    for (let i = 0; i < 3; i++) seedSession(srv, { userId: rich.id, state: "running" });
    const r = await post(srv, "/api/session/spawn", { token: richToken, body: {} });
    assert.equal(r.status, 429);
    assert.match(r.json.error, /max 3 machines/);
    assert.equal(countSessions(srv, rich.id), 3);
  });
});

// NOT COVERED (deliberate):
//   * A successful spawn. It would enqueue a provision_ubuntu job that a real
//     node agent turns into a real GPU container on `nightmare`. The tests above
//     cover every branch up to and including the preflight; the code after it is
//     row insertion and job dispatch.
//   * The positive half of the port-release fix — that a *terminal* session row
//     frees its port again. Observing it requires a spawn that succeeds all the
//     way to allocating that port, which dispatches a real provision job. The
//     negative half (live rows do hold their ports) is asserted above.
//   * A node going stale (>30s since lastSeen) as opposed to never registering.
//     Both take the same branch; asserting the stale case would need a 30s sleep
//     and the window is not configurable.
