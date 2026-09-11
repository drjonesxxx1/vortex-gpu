// Five-tier catalog + per-tier pricing + the LXC (pct) provisioning path.
//
// Black-box, like the rest of the suite: the real bundled server runs as a
// child, `ssh` is shimmed (helpers/harness.js) so `qm`/`pct` never leave the
// box, and rows that would otherwise require a real clone are seeded directly
// into the throwaway DB. Routing (qm vs pct) is asserted from the ssh-shim log,
// never by touching real infra.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { useServer } from "./helpers/harness.js";
import { get, post } from "./helpers/http.js";
import { seedUser, getUser, withDb } from "./helpers/db.js";

async function tokenFor(srv, user) {
  const r = await post(srv, "/api/auth/login", { body: { username: user.username, password: user.password } });
  assert.equal(r.status, 200, r.text);
  return r.json.token;
}

// Insert a vm row with an explicit tier + locked-in price (what a real provision
// would persist). seedVm() in helpers/db.js predates these columns.
function seedTierVm(srv, opts) {
  const id = opts.id ?? "vm_" + crypto.randomBytes(6).toString("hex");
  const vmid = opts.vmid ?? 9000 + Math.floor(Math.random() * 900);
  withDb(srv, (db) => {
    db.prepare(
      "INSERT INTO vms (id,user_id,vm_id,node_hostname,name,os,sku,state,ip,port,username,password,app,created_at,tier,price_usd_per_hour) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(id, opts.userId, vmid, "proxmox.invalid", opts.name ?? "vortex-test",
      opts.os ?? "linux", opts.sku ?? "TEST", opts.state ?? "running", null,
      opts.port ?? 30000 + Math.floor(Math.random() * 9000), "rent", "pw", "",
      opts.createdAt ?? Date.now(), opts.tier ?? null, opts.price ?? null);
  });
  return { id, vmid };
}

async function waitForSsh(srv, re, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (srv.sshCalls().some((c) => re.test(c))) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 40));
  }
}

// ---------------------------------------------------------------------------

describe("catalog: /api/health exposes the five tiers with prices", () => {
  const srv = useServer();

  it("returns an array of {tier,label,priceUsdPerHour,kind}", async () => {
    const r = await get(srv, "/api/health");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.catalog), "catalog must be an array");
    const byTier = Object.fromEntries(r.json.catalog.map((t) => [t.tier, t]));
    assert.deepEqual(
      r.json.catalog.map((t) => t.tier),
      ["ubuntu-ct", "linux-vm", "gpu", "win11", "comando"],
    );
    for (const t of r.json.catalog) {
      assert.equal(typeof t.label, "string");
      assert.equal(typeof t.priceUsdPerHour, "number");
      assert.ok(["qm", "pct", "gpu"].includes(t.kind), `bad kind ${t.kind}`);
    }
    // Default prices from the confirmed catalog.
    assert.equal(byTier["ubuntu-ct"].priceUsdPerHour, 1);
    assert.equal(byTier["linux-vm"].priceUsdPerHour, 2);
    assert.equal(byTier["gpu"].priceUsdPerHour, 5);
    assert.equal(byTier["win11"].priceUsdPerHour, 10);
    assert.equal(byTier["comando"].priceUsdPerHour, 20);
    // Mechanism per tier.
    assert.equal(byTier["ubuntu-ct"].kind, "pct");
    assert.equal(byTier["linux-vm"].kind, "qm");
    assert.equal(byTier["gpu"].kind, "gpu");
    // Existing fields still present.
    assert.equal(r.json.priceUsdPerHour, 1);
  });

  it("prices are overridable by env", async () => {
    const s2 = await import("./helpers/harness.js").then((m) =>
      m.startServer({ env: { PRICE_UBUNTU_CT: "3", PRICE_COMANDO: "42" } }));
    try {
      const r = await get(s2, "/api/health");
      const byTier = Object.fromEntries(r.json.catalog.map((t) => [t.tier, t]));
      assert.equal(byTier["ubuntu-ct"].priceUsdPerHour, 3);
      assert.equal(byTier["comando"].priceUsdPerHour, 42);
    } finally {
      await s2.stop();
    }
  });
});

describe("provisioning: routing qm vs pct by tier", () => {
  const srv = useServer();

  it("an ubuntu-ct provision routes to `pct clone 991`", async () => {
    const u = await import("./helpers/http.js").then((m) => m.registerUser(srv));
    const r = await post(srv, "/api/vms/provision", { token: u.token, body: { tier: "ubuntu-ct" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.tier, "ubuntu-ct");
    assert.equal(r.json.priceUsdPerHour, 1);
    // CT tiers now get an in-browser terminal proxied through the gateway, not a
    // dead private-IP SSH string. access is null; terminalUrl points at /machine/.
    assert.equal(r.json.access, null, "CT must not present a (non-functional) private-IP ssh access block");
    assert.match(r.json.terminalUrl, /^\/machine\/vm_/, "CT must return a browser terminal URL");
    assert.ok(await waitForSsh(srv, /pct clone 991/), `expected pct clone in: ${srv.sshCalls().join(" | ")}`);
    assert.ok(!srv.sshCalls().some((c) => /qm clone/.test(c)), "a CT must never use qm clone");
  });

  it("a comando provision routes to `qm clone 504`", async () => {
    const u = await import("./helpers/http.js").then((m) => m.registerUser(srv));
    const r = await post(srv, "/api/vms/provision", { token: u.token, body: { tier: "comando" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.tier, "comando");
    assert.equal(r.json.priceUsdPerHour, 20);
    assert.equal(r.json.access.protocol, "rdp");
    assert.ok(await waitForSsh(srv, /qm clone 504/), `expected qm clone in: ${srv.sshCalls().join(" | ")}`);
  });

  it("rejects tier=gpu (that path is /api/session/spawn)", async () => {
    const u = await import("./helpers/http.js").then((m) => m.registerUser(srv));
    const r = await post(srv, "/api/vms/provision", { token: u.token, body: { tier: "gpu" } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /session\/spawn/);
  });

  it("rejects an unknown tier", async () => {
    const u = await import("./helpers/http.js").then((m) => m.registerUser(srv));
    const r = await post(srv, "/api/vms/provision", { token: u.token, body: { tier: "nope" } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /unknown tier/);
  });
});

describe("provisioning: backward-compat os=windows|linux", () => {
  const srv = useServer();

  it("os=windows maps to the win11 tier (qm clone 810)", async () => {
    const u = await import("./helpers/http.js").then((m) => m.registerUser(srv));
    const r = await post(srv, "/api/vms/provision", { token: u.token, body: { os: "windows" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.tier, "win11");
    assert.equal(r.json.os, "windows");
    assert.ok(await waitForSsh(srv, /qm clone 810/), `expected qm clone 810 in: ${srv.sshCalls().join(" | ")}`);
  });

  it("os=linux maps to the linux-vm tier (qm clone 990)", async () => {
    const u = await import("./helpers/http.js").then((m) => m.registerUser(srv));
    const r = await post(srv, "/api/vms/provision", { token: u.token, body: { os: "linux" } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.tier, "linux-vm");
    assert.equal(r.json.os, "linux");
    assert.ok(await waitForSsh(srv, /qm clone 990/), `expected qm clone 990 in: ${srv.sshCalls().join(" | ")}`);
  });
});

describe("delete: reclaim routes pct destroy vs qm destroy by kind", () => {
  const srv = useServer();
  let user, token;

  before(async () => {
    user = seedUser(srv, { password: "hunter22", balanceMinutes: 600 });
    token = await tokenFor(srv, user);
  });

  it("a stopped ubuntu-ct row is reclaimed with `pct destroy`", async () => {
    const vm = seedTierVm(srv, { userId: user.id, state: "stopped", tier: "ubuntu-ct", price: 1 });
    const r = await post(srv, "/api/vms/delete", { token, body: { vmId: vm.id } });
    assert.equal(r.status, 200, r.text);
    assert.ok(srv.sshCalls().some((c) => new RegExp(`pct destroy ${vm.vmid}`).test(c)), srv.sshCalls().join(" | "));
    assert.ok(!srv.sshCalls().some((c) => new RegExp(`qm destroy ${vm.vmid}`).test(c)), "a CT must not use qm destroy");
  });

  it("a stopped comando (qm) row is reclaimed with `qm destroy`", async () => {
    const vm = seedTierVm(srv, { userId: user.id, state: "stopped", tier: "comando", price: 20, os: "windows" });
    const r = await post(srv, "/api/vms/delete", { token, body: { vmId: vm.id } });
    assert.equal(r.status, 200, r.text);
    assert.ok(srv.sshCalls().some((c) => new RegExp(`qm destroy ${vm.vmid}`).test(c)), srv.sshCalls().join(" | "));
  });

  it("a legacy NULL-tier row is reclaimed with `qm destroy` (qm is the default)", async () => {
    const vm = seedTierVm(srv, { userId: user.id, state: "stopped", tier: null, price: null });
    const r = await post(srv, "/api/vms/delete", { token, body: { vmId: vm.id } });
    assert.equal(r.status, 200, r.text);
    assert.ok(srv.sshCalls().some((c) => new RegExp(`qm destroy ${vm.vmid}`).test(c)), srv.sshCalls().join(" | "));
  });
});

// The sweep is normally once a minute; BILLING_TICK_MS lets the test observe it
// without waiting. It does NOT change the per-tick charge, only its cadence.
describe("billing: each machine is charged at ITS tier's price", () => {
  const srv = useServer({ env: { BILLING_TICK_MS: "800" } });

  // Poll fast (40ms) relative to the tick (800ms), so the first observed drop is
  // exactly one tick's charge.
  async function firstDrop(userId, start) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const b = getUser(srv, userId).balance_minutes;
      if (b < start) return start - b;
      if (Date.now() > deadline) throw new Error("balance never decremented");
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  it("bills the billable machine's own rate, not a flat $1/hr", async () => {
    const start = 100_000;
    const u = seedUser(srv, { balanceMinutes: start });
    // Oldest is spared (free machine); the billable one is a $20/hr comando.
    seedTierVm(srv, { userId: u.id, state: "running", tier: "ubuntu-ct", price: 1, createdAt: 1000 });
    seedTierVm(srv, { userId: u.id, state: "running", tier: "comando", price: 20, createdAt: 2000 });
    const drop = await firstDrop(u.id, start);
    // Per-tier: one billable $20/hr machine -> 20 per tick. Flat $1/hr would be 1.
    assert.equal(drop % 20, 0, `expected a multiple of 20, got ${drop}`);
    assert.ok(drop >= 20);
  });

  it("first-machine-free spares the OLDEST across mixed tiers", async () => {
    const start = 100_000;
    const u = seedUser(srv, { balanceMinutes: start });
    // Oldest is the EXPENSIVE comando -> it must be the one spared. The newer,
    // cheap linux-vm ($2/hr) is the only billable machine.
    seedTierVm(srv, { userId: u.id, state: "running", tier: "comando", price: 20, createdAt: 1000 });
    seedTierVm(srv, { userId: u.id, state: "running", tier: "linux-vm", price: 2, createdAt: 2000 });
    const drop = await firstDrop(u.id, start);
    // Correct (spare oldest comando): 2 per tick. Sparing the newest instead
    // would bill the comando at 20 -> drop divisible by 20.
    assert.equal(drop, 2, `expected 2 (only the $2 linux-vm billable), got ${drop}`);
  });

  it("a GPU session is billed at the gpu tier price ($5/hr)", async () => {
    const start = 100_000;
    const u = seedUser(srv, { balanceMinutes: start });
    // A spared free vm + a billable gpu session.
    seedTierVm(srv, { userId: u.id, state: "running", tier: "ubuntu-ct", price: 1, createdAt: 1000 });
    withDb(srv, (db) => {
      db.prepare(
        "INSERT INTO sessions (id,user_id,instance_id,node_hostname,node_ip,port,password,resolution,proxy,state,created_at,tier,price_usd_per_hour) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run("ses_" + crypto.randomBytes(6).toString("hex"), u.id, "sess_" + crypto.randomBytes(16).toString("hex"),
        "testnode", "127.0.0.1", 6099, "pw", "1440x900", null, "running", 2000, "gpu", 5);
    });
    const drop = await firstDrop(u.id, start);
    assert.equal(drop, 5, `expected 5 (gpu tier), got ${drop}`);
  });
});
