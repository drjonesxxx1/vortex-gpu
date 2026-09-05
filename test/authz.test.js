// Authorization: tenant isolation, the deliberately-undiscoverable admin
// surface, and the node secret.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "./helpers/harness.js";
import { get, post } from "./helpers/http.js";
import { seedUser, seedVm, seedSession, getVm, getSession, getUser } from "./helpers/db.js";

async function tokenFor(srv, user) {
  const r = await post(srv, "/api/auth/login", { body: { username: user.username, password: user.password } });
  assert.equal(r.status, 200, r.text);
  return r.json.token;
}

describe("authz: one tenant cannot reach another's machines", () => {
  const srv = useServer();
  let alice, bob, aliceToken, bobToken, aliceVm, aliceStoppedVm, aliceSession, aliceStoppedSession;

  before(async () => {
    alice = seedUser(srv, { password: "hunter22" });
    bob = seedUser(srv, { password: "hunter22" });
    aliceToken = await tokenFor(srv, alice);
    bobToken = await tokenFor(srv, bob);
    // Seeded directly: creating these for real would clone a KVM guest and start
    // a GPU container. See the NOT COVERED note at the bottom of this file.
    aliceVm = seedVm(srv, { userId: alice.id, state: "running" });
    aliceStoppedVm = seedVm(srv, { userId: alice.id, state: "stopped" });
    aliceSession = seedSession(srv, { userId: alice.id, state: "running" });
    aliceStoppedSession = seedSession(srv, { userId: alice.id, state: "stopped" });
  });

  it("Bob's /api/me shows none of Alice's machines", async () => {
    const r = await get(srv, "/api/me", { token: bobToken });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.vms, []);
    assert.deepEqual(r.json.sessions, []);
  });

  it("Bob's /api/sessions is a bare empty array, not Alice's sessions", async () => {
    const r = await get(srv, "/api/sessions", { token: bobToken });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json), "/api/sessions returns a bare array, not {sessions:[...]}");
    assert.equal(r.json.length, 0);
  });

  it("Bob cannot destroy Alice's vm: 404, no state change, no hypervisor call", async () => {
    const before = srv.sshCalls().length;
    const r = await post(srv, "/api/vms/destroy", { token: bobToken, body: { vmId: aliceVm.id } });
    assert.equal(r.status, 404);
    assert.match(r.json.error, /not found/);
    assert.equal(getVm(srv, aliceVm.id).state, "running");
    assert.equal(srv.sshCalls().length, before, "a cross-tenant destroy must never reach qm");
  });

  it("Bob cannot delete Alice's stopped vm: 404, row survives, no reclaim", async () => {
    const before = srv.sshCalls().length;
    const r = await post(srv, "/api/vms/delete", { token: bobToken, body: { vmId: aliceStoppedVm.id } });
    assert.equal(r.status, 404);
    assert.ok(getVm(srv, aliceStoppedVm.id), "Alice's row must survive");
    assert.equal(srv.sshCalls().length, before, "a cross-tenant delete must never reach qm destroy");
  });

  it("Bob cannot destroy Alice's session: 404, no state change", async () => {
    const r = await post(srv, "/api/session/destroy", { token: bobToken, body: { sessionId: aliceSession.id } });
    assert.equal(r.status, 404);
    assert.equal(getSession(srv, aliceSession.id).state, "running");
  });

  it("Bob cannot delete Alice's stopped session: 404, row survives", async () => {
    const r = await post(srv, "/api/session/delete", { token: bobToken, body: { sessionId: aliceStoppedSession.id } });
    assert.equal(r.status, 404);
    assert.ok(getSession(srv, aliceStoppedSession.id));
  });

  it("the 404 body never carries another tenant's data", async () => {
    for (const [path, body] of [
      ["/api/vms/destroy", { vmId: aliceVm.id }],
      ["/api/vms/delete", { vmId: aliceStoppedVm.id }],
      ["/api/session/destroy", { sessionId: aliceSession.id }],
      ["/api/session/delete", { sessionId: aliceStoppedSession.id }],
    ]) {
      const r = await post(srv, path, { token: bobToken, body });
      assert.equal(r.status, 404);
      assert.deepEqual(r.json, { error: "not found" });
      assert.doesNotMatch(r.text, new RegExp(alice.id));
    }
  });

  it("Alice still owns her machines afterwards", async () => {
    const r = await get(srv, "/api/me", { token: aliceToken });
    assert.equal(r.status, 200);
    assert.equal(r.json.vms.length, 2);
    assert.equal(r.json.sessions.length, 2);
    assert.doesNotMatch(r.text, /password_hash/);
  });

  it("an unauthenticated caller gets 401 (not 404) on the machine routes", async () => {
    for (const path of ["/api/vms/destroy", "/api/vms/delete", "/api/session/destroy", "/api/session/delete"]) {
      assert.equal((await post(srv, path, { body: {} })).status, 401);
    }
  });
});

describe("authz: the admin surface is undiscoverable (404, never 403)", () => {
  const srv = useServer();

  const ADMIN_GETS = ["/api/admin/state"];
  const ADMIN_POSTS = [
    ["/api/admin/gpu/run", { hostname: "testnode", command: "id" }],
    ["/api/admin/set-password", { username: "whoever", newPassword: "hunter22" }],
    ["/api/admin/credit", { userId: "usr_x", minutes: 10 }],
  ];

  it("returns 404 with no token at all", async () => {
    for (const p of ADMIN_GETS) assert.equal((await get(srv, p)).status, 404, p);
    for (const [p, body] of ADMIN_POSTS) assert.equal((await post(srv, p, { body })).status, 404, p);
  });

  it("returns 404 with a wrong token, and never 403", async () => {
    for (const token of ["wrong", "Bearer wrong", srv.adminToken + "x", srv.adminToken.slice(0, -1)]) {
      for (const p of ADMIN_GETS) {
        const r = await get(srv, p, { token });
        assert.equal(r.status, 404, `${p} with ${token}`);
      }
      for (const [p, body] of ADMIN_POSTS) {
        const r = await post(srv, p, { token, body });
        assert.equal(r.status, 404, `${p} with ${token}`);
      }
    }
  });

  it("a tenant's own bearer token does not open the admin surface", async () => {
    const u = seedUser(srv, { password: "hunter22" });
    const token = await tokenFor(srv, u);
    assert.equal((await get(srv, "/api/admin/state", { token })).status, 404);
  });

  it("GET /admin is 404 without the token and serves the page with it", async () => {
    assert.equal((await get(srv, "/admin")).status, 404);
    assert.equal((await get(srv, "/admin?token=wrong")).status, 404);
    const ok = await get(srv, `/admin?token=${srv.adminToken}`);
    assert.equal(ok.status, 200);
  });

  it("with the right token /api/admin/state answers", async () => {
    const r = await get(srv, "/api/admin/state", { token: srv.adminToken });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.users));
    assert.doesNotMatch(r.text, /password_hash/, "the admin view must not carry hashes either");
    // NOTE: /api/admin/state does return btcpay_invoice_id and tenant machine
    // passwords (it SELECTs *). That is admin-only by design — the caller must
    // already hold ADMIN_TOKEN — so it is not asserted against here.
  });

  it("/api/admin/credit validates its input", async () => {
    const u = seedUser(srv);
    const token = srv.adminToken;
    assert.equal((await post(srv, "/api/admin/credit", { token, body: { minutes: 5 } })).status, 400);
    assert.equal((await post(srv, "/api/admin/credit", { token, body: { userId: u.id, minutes: 1e9 } })).status, 400);
    assert.equal((await post(srv, "/api/admin/credit", { token, body: { userId: u.id, minutes: "abc" } })).status, 200);
    assert.equal(getUser(srv, u.id).balance_minutes, 0, "a non-numeric credit is coerced to 0, never to NaN");
    assert.equal((await post(srv, "/api/admin/credit", { token, body: { userId: "usr_nope", minutes: 5 } })).status, 404);
    assert.equal((await post(srv, "/api/admin/credit", { token, body: { userId: u.id, minutes: 90 } })).status, 200);
    assert.equal(getUser(srv, u.id).balance_minutes, 90);
    // Floats are truncated rather than refused, and balance never goes negative.
    assert.equal((await post(srv, "/api/admin/credit", { token, body: { userId: u.id, minutes: 1.9 } })).status, 200);
    assert.equal(getUser(srv, u.id).balance_minutes, 91);
    assert.equal((await post(srv, "/api/admin/credit", { token, body: { userId: u.id, minutes: -1000 } })).status, 200);
    assert.equal(getUser(srv, u.id).balance_minutes, 0, "balance_minutes is floored at 0");
  });
});

describe("authz: /api/admin/set-password recovers a NULL-hash account", () => {
  const srv = useServer();
  let legacy;

  before(() => { legacy = seedUser(srv, { username: "stranded_acct", passwordHash: null }); });

  it("is 404 without admin auth, even though the account is credential-less", async () => {
    const r = await post(srv, "/api/admin/set-password", {
      body: { username: "stranded_acct", newPassword: "recovered-pw" },
    });
    assert.equal(r.status, 404);
    assert.equal(getUser(srv, legacy.id).password_hash, null);
  });

  it("sets the first password for a NULL-hash account when admin-authenticated", async () => {
    const before = await post(srv, "/api/auth/login", { body: { username: "stranded_acct", password: "recovered-pw" } });
    assert.equal(before.status, 403, "locked out before recovery");

    const r = await post(srv, "/api/admin/set-password", {
      token: srv.adminToken, body: { username: "stranded_acct", newPassword: "recovered-pw" },
    });
    assert.equal(r.status, 200);

    const after = await post(srv, "/api/auth/login", { body: { username: "stranded_acct", password: "recovered-pw" } });
    assert.equal(after.status, 200, "the account is usable again");
    assert.match(after.json.token, /^[0-9a-f]{64}$/);
  });

  it("revokes existing tokens for the account it resets", async () => {
    const u = seedUser(srv, { password: "hunter22" });
    const token = await tokenFor(srv, u);
    assert.equal((await get(srv, "/api/me", { token })).status, 200);

    const r = await post(srv, "/api/admin/set-password", {
      token: srv.adminToken, body: { userId: u.id, newPassword: "operator-set" },
    });
    assert.equal(r.status, 200);
    assert.equal((await get(srv, "/api/me", { token })).status, 401, "a reset must invalidate held tokens");
  });

  it("enforces the same password rules as register", async () => {
    const u = seedUser(srv);
    const token = srv.adminToken;
    assert.equal((await post(srv, "/api/admin/set-password", { token, body: { userId: u.id, newPassword: "12345" } })).status, 400);
    assert.equal((await post(srv, "/api/admin/set-password", { token, body: { userId: u.id, newPassword: "x".repeat(201) } })).status, 400);
    assert.equal((await post(srv, "/api/admin/set-password", { token, body: { newPassword: "hunter22" } })).status, 400);
    assert.equal((await post(srv, "/api/admin/set-password", { token, body: { userId: "usr_nope", newPassword: "hunter22" } })).status, 404);
  });
});

describe("authz: the node layer requires X-NODE-SECRET", () => {
  const srv = useServer();

  const NODE_ROUTES = [
    ["POST", "/api/node/register", { hostname: "testnode" }],
    ["POST", "/api/node/report", { hostname: "testnode", memTotalMb: 16384 }],
    ["GET", "/api/node/jobs", undefined],
    ["POST", "/api/node/jobs/job_abc/result", { ok: true }],
  ];

  it("rejects a missing, wrong, or truncated secret with 401", async () => {
    for (const secret of [undefined, "", "wrong", srv.nodeSecret + "x", srv.nodeSecret.slice(0, -1)]) {
      for (const [method, path, body] of NODE_ROUTES) {
        const headers = secret === undefined ? {} : { "x-node-secret": secret };
        const r = method === "GET"
          ? await get(srv, path, { headers })
          : await post(srv, path, { headers, body });
        assert.equal(r.status, 401, `${method} ${path} with secret ${JSON.stringify(secret)}`);
        assert.match(r.json.error, /unauthorized/);
      }
    }
  });

  it("a tenant bearer token is not a node secret", async () => {
    const u = seedUser(srv, { password: "hunter22" });
    const token = await tokenFor(srv, u);
    const r = await post(srv, "/api/node/register", { token, body: { hostname: "testnode" } });
    assert.equal(r.status, 401);
  });

  it("accepts the real secret and validates the hostname charset", async () => {
    const headers = { "x-node-secret": srv.nodeSecret };
    assert.equal((await post(srv, "/api/node/register", { headers, body: { hostname: "testnode", memTotalMb: 16384 } })).status, 200);
    // "__proto__" is the dangerous one: `nodes[hostname] = {...}` on a plain
    // object would otherwise reassign the prototype rather than set a key.
    for (const hostname of ["", "__proto__", "has space", "-leading", "a".repeat(64), "back\\slash"]) {
      const r = await post(srv, "/api/node/register", { headers, body: { hostname } });
      assert.equal(r.status, 400, `hostname ${JSON.stringify(hostname)} must be refused`);
    }
    const state = await get(srv, "/api/admin/state", { token: srv.adminToken });
    const names = state.json.nodes.map((n) => n.hostname);
    assert.ok(names.includes("testnode"), "the valid registration landed");
    for (const bad of ["", "__proto__", "has space", "-leading", "back\\slash"]) {
      assert.ok(!names.includes(bad), `refused hostname ${JSON.stringify(bad)} must not be in the registry`);
    }
  });

  // Observed behaviour, pinned deliberately: the source comment claims the
  // hostname charset keeps both "__proto__" and "constructor" out of the
  // registry, but "constructor" passes the regex. It is harmless (the write is
  // an own property, not a prototype reassignment) — this test exists so that
  // stays true if the registry's backing store ever changes.
  it("a node literally named \"constructor\" is accepted without corrupting the registry", async () => {
    const headers = { "x-node-secret": srv.nodeSecret };
    assert.equal((await post(srv, "/api/node/register", { headers, body: { hostname: "constructor" } })).status, 200);
    const state = await get(srv, "/api/admin/state", { token: srv.adminToken });
    const names = state.json.nodes.map((n) => n.hostname);
    assert.ok(names.includes("constructor"));
    assert.ok(names.every((n) => typeof n === "string"));
    // The registry still behaves like a registry.
    assert.equal((await get(srv, "/api/health")).status, 200);
  });
});

// NOT COVERED (deliberate):
//   * POST /api/vms/provision — clones a real KVM guest on Proxmox. The rows it
//     would create are seeded directly instead, so every authorization and
//     lifecycle assertion above still runs against the real handlers.
//   * The /session/<id>/ noVNC reverse proxy's happy path — it needs a live
//     websockify behind it. Its DB state gate is covered in machines.test.js.
