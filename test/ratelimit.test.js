// Rate limiting. These are the only tests that pin an X-Forwarded-For value:
// everywhere else each request gets a random one precisely so it cannot land in
// a shared bucket. Each test below uses its own fixed address.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "./helpers/harness.js";
import { get, post } from "./helpers/http.js";
import { seedUser } from "./helpers/db.js";

function assertRetryAfter(r) {
  assert.equal(r.status, 429);
  assert.match(r.json.error, /too many requests/);
  const header = r.headers.get("retry-after");
  assert.ok(header, "429 must carry a Retry-After header");
  const secs = Number(header);
  assert.ok(Number.isInteger(secs) && secs > 0, `Retry-After must be positive whole seconds, got ${header}`);
  assert.equal(secs, r.json.retryAfterSec);
}

describe("rate limiting: login", () => {
  const srv = useServer();

  it("a burst from one address yields 429 with Retry-After (20 per 5 min)", async () => {
    const ip = "100.100.0.1";
    const statuses = [];
    // Distinct usernames, so this exercises the per-IP limiter rather than the
    // tighter per-username one.
    for (let i = 0; i < 24; i++) {
      const r = await post(srv, "/api/auth/login", { ip, body: { username: `victim${i}`, password: "hunter22" } });
      statuses.push(r.status);
      if (r.status === 429) { assertRetryAfter(r); break; }
    }
    assert.ok(statuses.includes(429), `expected a 429 in the burst, got ${statuses.join(",")}`);
    assert.equal(statuses.filter((s) => s === 401).length, 20, "exactly 20 attempts should get through");
  });

  it("the per-username limiter cannot be rotated around by changing IP (10 per 15 min)", async () => {
    let blocked = 0;
    let allowed = 0;
    for (let i = 0; i < 14; i++) {
      // A different source address every time — a distributed attacker.
      const r = await post(srv, "/api/auth/login", { body: { username: "targeted_acct", password: "guess" + i } });
      if (r.status === 429) { assertRetryAfter(r); blocked++; } else { allowed++; }
    }
    assert.equal(allowed, 10, "the username bucket must hold regardless of source IP");
    assert.equal(blocked, 4);
  });

  it("the username bucket is case-insensitive", async () => {
    for (let i = 0; i < 10; i++) {
      await post(srv, "/api/auth/login", { body: { username: "MixedCase", password: "x" } });
    }
    const r = await post(srv, "/api/auth/login", { body: { username: "mixedcase", password: "x" } });
    assertRetryAfter(r);
  });

  it("one address being limited does not lock out another", async () => {
    const busy = "100.100.0.2";
    for (let i = 0; i < 25; i++) {
      await post(srv, "/api/auth/login", { ip: busy, body: { username: `noisy${i}`, password: "x" } });
    }
    assert.equal((await post(srv, "/api/auth/login", { ip: busy, body: { username: "noisyX", password: "x" } })).status, 429);
    const other = await post(srv, "/api/auth/login", { ip: "100.100.0.3", body: { username: "quiet", password: "x" } });
    assert.equal(other.status, 401, "a different network must be unaffected");
  });
});

describe("rate limiting: register", () => {
  const srv = useServer();

  it("caps account farming at 10 per hour per address", async () => {
    const ip = "100.101.0.1";
    let created = 0;
    for (let i = 0; i < 13; i++) {
      const r = await post(srv, "/api/auth/register", { ip, body: { username: `farm${i}`, password: "hunter22" } });
      if (r.status === 200) { created++; continue; }
      assertRetryAfter(r);
    }
    assert.equal(created, 10, "every new account carries a free machine slot — the cap must hold");
  });
});

describe("rate limiting: provisioning", () => {
  const srv = useServer();
  let token;

  before(async () => {
    const u = seedUser(srv, { password: "hunter22", balanceMinutes: 600 });
    const login = await post(srv, "/api/auth/login", { body: { username: u.username, password: "hunter22" } });
    token = login.json.token;
  });

  it("caps spawn attempts per account, and the cap is not the machine-limit 429", async () => {
    // The session node is never registered here, so every attempt that gets
    // through the limiter stops at the node-offline check. Nothing is provisioned.
    let offline = 0;
    let limited = 0;
    for (let i = 0; i < 13; i++) {
      const r = await post(srv, "/api/session/spawn", { token, body: {} });
      if (r.status === 503) { offline++; assert.match(r.json.error, /GPU node offline/); continue; }
      assertRetryAfter(r);
      assert.doesNotMatch(r.json.error, /max 3 machines/, "this must be the rate limiter, not the slot cap");
      limited++;
    }
    assert.equal(offline, 10);
    assert.equal(limited, 3);
  });

  it("the limiter is keyed by account, so a second account is unaffected", async () => {
    const u = seedUser(srv, { password: "hunter22" });
    const login = await post(srv, "/api/auth/login", { body: { username: u.username, password: "hunter22" } });
    const r = await post(srv, "/api/session/spawn", { token: login.json.token, body: {} });
    assert.equal(r.status, 503);
    assert.match(r.json.error, /GPU node offline/);
  });
});

describe("rate limiting: change-password", () => {
  const srv = useServer();

  it("caps attempts per account (10 per 15 min)", async () => {
    const u = seedUser(srv, { password: "hunter22" });
    const login = await post(srv, "/api/auth/login", { body: { username: u.username, password: "hunter22" } });
    const token = login.json.token;
    let wrong = 0;
    let limited = 0;
    for (let i = 0; i < 13; i++) {
      const r = await post(srv, "/api/auth/change-password", {
        token, body: { currentPassword: "guess" + i, newPassword: "newpassword" },
      });
      if (r.status === 401) { wrong++; continue; }
      assertRetryAfter(r);
      limited++;
    }
    assert.equal(wrong, 10, "scrypt work must be bounded");
    assert.equal(limited, 3);
    // The account is untouched by the failed attempts.
    const still = await post(srv, "/api/auth/login", { body: { username: u.username, password: "hunter22" } });
    assert.equal(still.status, 200);
  });
});

describe("rate limiting: unlimited routes are genuinely unlimited", () => {
  const srv = useServer();

  it("health is not rate limited (the storefront polls it)", async () => {
    const ip = "100.102.0.1";
    for (let i = 0; i < 40; i++) {
      assert.equal((await get(srv, "/api/health", { ip })).status, 200);
    }
  });
});
