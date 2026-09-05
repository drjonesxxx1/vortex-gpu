// Registration, login, tokens, password change and logout.
//
// Every request gets its own X-Forwarded-For (see helpers/http.js) so the
// per-IP register/login limiters cannot make one test depend on another.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { useServer } from "./helpers/harness.js";
import { get, post, registerUser } from "./helpers/http.js";
import { seedUser, getUser } from "./helpers/db.js";

const HEX64 = /^[0-9a-f]{64}$/;

describe("auth: register", () => {
  const srv = useServer();

  it("succeeds and returns a 64-hex bearer token", async () => {
    const r = await post(srv, "/api/auth/register", { body: { username: "alice.one", password: "hunter22" } });
    assert.equal(r.status, 200);
    assert.match(r.json.token, HEX64);
    assert.equal(r.json.user.username, "alice.one");
    assert.equal(r.json.user.balance_minutes, 0);
    assert.equal(r.json.user.unlimited, false);
    assert.ok(!("password_hash" in r.json.user), "register must not echo the hash");
    assert.doesNotMatch(r.text, /password_hash/);
  });

  it("rejects a duplicate username with 409", async () => {
    const body = { username: "dupe_user", password: "hunter22" };
    assert.equal((await post(srv, "/api/auth/register", { body })).status, 200);
    const second = await post(srv, "/api/auth/register", { body });
    assert.equal(second.status, 409);
    assert.match(second.json.error, /already taken/);
  });

  it("rejects a password shorter than 6 chars with 400", async () => {
    const r = await post(srv, "/api/auth/register", { body: { username: "shortpw", password: "12345" } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /at least 6/);
  });

  it("rejects a password longer than 200 chars with 400", async () => {
    const r = await post(srv, "/api/auth/register", { body: { username: "longpw", password: "x".repeat(201) } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /at most 200/);
  });

  it("rejects usernames outside ^[a-zA-Z0-9_.-]{3,32}$ with 400", async () => {
    for (const username of ["ab", "has space", "sql'inject", "bad/slash", "emoji\u{1F600}x"]) {
      const r = await post(srv, "/api/auth/register", { body: { username, password: "hunter22" } });
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(username)}, got ${r.status}`);
    }
  });

  it("rejects a missing username with 400", async () => {
    const r = await post(srv, "/api/auth/register", { body: { password: "hunter22" } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /username required/);
  });

  // Observed behaviour, pinned so a refactor cannot change it silently: the
  // username is slice(0,32)'d BEFORE the regex runs, so an over-long name is
  // truncated and accepted rather than refused.
  it("truncates an over-long username to 32 chars rather than rejecting it", async () => {
    const r = await post(srv, "/api/auth/register", { body: { username: "z".repeat(40), password: "hunter22" } });
    assert.equal(r.status, 200);
    assert.equal(r.json.user.username, "z".repeat(32));
  });
});

describe("auth: login", () => {
  const srv = useServer();
  let user;

  before(() => { user = seedUser(srv, { password: "hunter22" }); });

  it("returns a 64-hex token on success", async () => {
    const r = await post(srv, "/api/auth/login", { body: { username: user.username, password: "hunter22" } });
    assert.equal(r.status, 200);
    assert.match(r.json.token, HEX64);
    assert.equal(r.json.user.id, user.id);
    assert.doesNotMatch(r.text, /password_hash/);
  });

  it("rejects a wrong password with 401", async () => {
    const r = await post(srv, "/api/auth/login", { body: { username: user.username, password: "wrong-one" } });
    assert.equal(r.status, 401);
    assert.match(r.json.error, /wrong password/);
  });

  it("rejects an unknown username with 401", async () => {
    const r = await post(srv, "/api/auth/login", { body: { username: "nobody_here", password: "hunter22" } });
    assert.equal(r.status, 401);
  });

  it("rejects an over-long password with 400 before doing any scrypt work", async () => {
    const r = await post(srv, "/api/auth/login", { body: { username: user.username, password: "x".repeat(201) } });
    assert.equal(r.status, 400);
  });
});

// The account-takeover hole: a legacy row with no credential set must be a hard
// 403 and must NOT be claimable by whoever logs in first.
describe("auth: NULL password_hash accounts are not claimable", () => {
  const srv = useServer();
  let legacy;

  before(() => {
    legacy = seedUser(srv, { username: "legacy_null", passwordHash: null });
    seedUser(srv, { username: "legacy_blank", passwordHash: "" });
  });

  it("login against a NULL hash is 403, not 401 and not a silent claim", async () => {
    const r = await post(srv, "/api/auth/login", { body: { username: "legacy_null", password: "attacker-pw" } });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /no password set/);
    assert.equal(r.json.token, undefined, "no token may be issued");
    assert.equal(getUser(srv, legacy.id).password_hash, null, "the submitted password must not be adopted");
  });

  it("a blank hash behaves the same", async () => {
    const r = await post(srv, "/api/auth/login", { body: { username: "legacy_blank", password: "attacker-pw" } });
    assert.equal(r.status, 403);
  });

  it("re-submitting the same password still fails — the first attempt claimed nothing", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await post(srv, "/api/auth/login", { body: { username: "legacy_null", password: "attacker-pw" } });
      assert.equal(r.status, 403);
    }
    assert.equal(getUser(srv, legacy.id).password_hash, null);
  });
});

describe("auth: bearer token is required", () => {
  const srv = useServer();
  let acct;

  before(async () => { acct = await registerUser(srv); });

  for (const path of ["/api/me", "/api/account", "/api/invoices", "/api/sessions"]) {
    it(`${path} is 401 without a token`, async () => {
      assert.equal((await get(srv, path)).status, 401);
    });
    it(`${path} is 401 with a garbage token`, async () => {
      assert.equal((await get(srv, path, { token: "not-a-real-token" })).status, 401);
      assert.equal((await get(srv, path, { token: "f".repeat(64) })).status, 401);
    });
  }

  it("/api/me returns the caller's account and leaks no hash", async () => {
    const r = await get(srv, "/api/me", { token: acct.token });
    assert.equal(r.status, 200);
    assert.equal(r.json.user.username, acct.username);
    assert.deepEqual(r.json.vms, []);
    assert.deepEqual(r.json.sessions, []);
    assert.doesNotMatch(r.text, /password_hash/);
  });

  it("/api/account returns the settings view and leaks no hash", async () => {
    const r = await get(srv, "/api/account", { token: acct.token });
    assert.equal(r.status, 200);
    assert.equal(r.json.user.username, acct.username);
    assert.match(r.json.user.btc_address, /^bc1q/);
    assert.doesNotMatch(r.text, /password_hash/);
  });

  it("the x-auth-token header is accepted as an alternative to Bearer", async () => {
    const r = await get(srv, "/api/me", { headers: { "x-auth-token": acct.token } });
    assert.equal(r.status, 200);
  });
});

describe("auth: change-password", () => {
  const srv = useServer();

  it("rejects a wrong current password with 401 and changes nothing", async () => {
    const acct = await registerUser(srv, { password: "original-pw" });
    const r = await post(srv, "/api/auth/change-password", {
      token: acct.token, body: { currentPassword: "not-it", newPassword: "brand-new-pw" },
    });
    assert.equal(r.status, 401);
    const still = await post(srv, "/api/auth/login", { body: { username: acct.username, password: "original-pw" } });
    assert.equal(still.status, 200, "the original password must still work");
  });

  it("rejects a short new password with 400", async () => {
    const acct = await registerUser(srv, { password: "original-pw" });
    const r = await post(srv, "/api/auth/change-password", {
      token: acct.token, body: { currentPassword: "original-pw", newPassword: "12345" },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /at least 6/);
  });

  it("requires authentication", async () => {
    const r = await post(srv, "/api/auth/change-password", { body: { currentPassword: "a", newPassword: "bbbbbb" } });
    assert.equal(r.status, 401);
  });

  it("on success keeps the caller's token, revokes every other one, and retires the old password", async () => {
    const acct = await registerUser(srv, { password: "original-pw" });
    // A second live session for the same account (a phone, say).
    const other = await post(srv, "/api/auth/login", { body: { username: acct.username, password: "original-pw" } });
    assert.equal(other.status, 200);
    const otherToken = other.json.token;
    assert.notEqual(otherToken, acct.token);

    const r = await post(srv, "/api/auth/change-password", {
      token: acct.token, body: { currentPassword: "original-pw", newPassword: "second-pw" },
    });
    assert.equal(r.status, 200);

    assert.equal((await get(srv, "/api/me", { token: acct.token })).status, 200, "caller's own token must survive");
    assert.equal((await get(srv, "/api/me", { token: otherToken })).status, 401, "other sessions must be revoked");

    const oldPw = await post(srv, "/api/auth/login", { body: { username: acct.username, password: "original-pw" } });
    assert.equal(oldPw.status, 401, "the old password must stop working");
    const newPw = await post(srv, "/api/auth/login", { body: { username: acct.username, password: "second-pw" } });
    assert.equal(newPw.status, 200, "the new password must work");
  });

  it("is refused with 403 for a NULL-hash account (it must not set the first password)", async () => {
    // Such an account cannot obtain a token through login, so reaching this
    // route at all requires a token issued before the hash was cleared. Seed
    // the user with a hash, log in, then clear it — the same shape as a legacy
    // row whose credential was dropped underneath a live session.
    const u = seedUser(srv, { password: "temp-pw-123" });
    const login = await post(srv, "/api/auth/login", { body: { username: u.username, password: "temp-pw-123" } });
    assert.equal(login.status, 200);
    const { withDb } = await import("./helpers/db.js");
    withDb(srv, (db) => db.prepare("UPDATE users SET password_hash=NULL WHERE id=?").run(u.id));

    const r = await post(srv, "/api/auth/change-password", {
      token: login.json.token, body: { currentPassword: "temp-pw-123", newPassword: "attacker-pw" },
    });
    assert.equal(r.status, 403);
    assert.equal(getUser(srv, u.id).password_hash, null);
  });
});

describe("auth: logout", () => {
  const srv = useServer();

  it("/api/auth/logout revokes only the caller's token and is not shadowed by logout-all", async () => {
    const acct = await registerUser(srv, { password: "original-pw" });
    const other = await post(srv, "/api/auth/login", { body: { username: acct.username, password: "original-pw" } });
    const otherToken = other.json.token;

    const r = await post(srv, "/api/auth/logout", { token: acct.token });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal((await get(srv, "/api/me", { token: acct.token })).status, 401);
    assert.equal((await get(srv, "/api/me", { token: otherToken })).status, 200, "logout must not be logout-all");
  });

  it("/api/auth/logout-all revokes the caller's token too", async () => {
    const acct = await registerUser(srv, { password: "original-pw" });
    const other = await post(srv, "/api/auth/login", { body: { username: acct.username, password: "original-pw" } });

    const r = await post(srv, "/api/auth/logout-all", { token: acct.token });
    assert.equal(r.status, 200);
    assert.equal((await get(srv, "/api/me", { token: acct.token })).status, 401, "caller's token must die too");
    assert.equal((await get(srv, "/api/me", { token: other.json.token })).status, 401);
  });

  it("/api/auth/logout-all requires authentication", async () => {
    assert.equal((await post(srv, "/api/auth/logout-all", {})).status, 401);
  });
});
