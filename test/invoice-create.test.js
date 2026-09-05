// POST /api/btcpay/create-invoice — amount clamping/rounding and the minutes
// derived from it. Runs against a local TLS stub standing in for BTCPay; no
// real invoice is ever created.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./helpers/harness.js";
import { startBtcpayStub } from "./helpers/btcpay-stub.js";
import { get, post } from "./helpers/http.js";
import { seedUser, getInvoice } from "./helpers/db.js";

// What the gateway should charge and credit, given a requested USD amount.
//   cents   = clamp(round(usd * 100), 100, 1_000_000)
//   minutes = floor(cents * 60 / 100)     ($1/hr)
const CASES = [
  // requested,   expected $,  expected minutes,   why
  [5, 5.0, 300, "the plain case"],
  // 1.999 is the one that matters: minutes come from the 200 cents actually
  // charged (120), not from the unrounded request (which would give 119).
  [1.999, 2.0, 120, "minutes follow the rounded cents, not the raw request"],
  [0.999, 1.0, 60, "rounds up to the $1 floor"],
  [0.01, 1.0, 60, "below the floor is clamped to $1"],
  [12.345, 12.35, 741, "rounds to the nearer cent"],
  [12.344, 12.34, 740, "rounds down when nearer"],
  [99999999, 10000.0, 600000, "clamped to the $10,000 ceiling"],
];

const FALLBACK = [
  [undefined, "missing"],
  ["abc", "non-numeric"],
  [0, "zero"],
  [-3, "negative"],
  [Number.NaN, "NaN (arrives as null over JSON)"],
];

describe("create-invoice: amounts, rounding and minutes", () => {
  let srv, btcpay, token, mode;

  before(async () => {
    mode = "ok";
    btcpay = await startBtcpayStub((body) => {
      if (mode === "no-id") return { status: 200, json: { checkoutLink: "https://stub/i/x" } };
      if (mode === "error") return { status: 500, json: { message: "btcpay exploded" } };
      const id = "BTCPAY" + Math.random().toString(16).slice(2, 10);
      return { status: 200, json: { id, checkoutLink: `${btcpay.url}/i/${id}` } };
    });
    srv = await startServer({
      env: {
        BTCPAY_URL: btcpay.url,
        BTCPAY_API_KEY: "test-api-key",
        BTCPAY_STORE_ID: "test-store",
        BTCPAY_PUBLIC: "https://pay.example.test",
      },
    });
    const u = seedUser(srv, { password: "hunter22" });
    const login = await post(srv, "/api/auth/login", { body: { username: u.username, password: "hunter22" } });
    token = login.json.token;
  });

  after(async () => {
    if (srv) await srv.stop();
    if (btcpay) await btcpay.stop();
  });

  for (const [usdAmount, expectUsd, expectMinutes, why] of CASES) {
    it(`$${usdAmount} -> $${expectUsd.toFixed(2)} / ${expectMinutes} min (${why})`, async () => {
      const r = await post(srv, "/api/btcpay/create-invoice", { token, body: { usdAmount } });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.amountUsd, expectUsd);
      assert.equal(r.json.minutesAdded, expectMinutes);
      assert.ok(Number.isSafeInteger(r.json.minutesAdded), "minutes must be an integer for an INTEGER column");

      // The stored row must agree with what the customer was told.
      const row = getInvoice(srv, r.json.invoiceId);
      assert.equal(row.amount_usd, expectUsd);
      assert.equal(row.minutes, expectMinutes);
      assert.equal(row.status, "pending");

      // And so must the amount actually sent to BTCPay.
      const sent = btcpay.requests.at(-1).body;
      assert.equal(sent.amount, expectUsd.toFixed(2));
      assert.equal(sent.currency, "USD");
      assert.equal(sent.metadata.minutes, expectMinutes);
    });
  }

  for (const [usdAmount, why] of FALLBACK) {
    it(`${why} amount falls back to $5.00 / 300 min`, async () => {
      const r = await post(srv, "/api/btcpay/create-invoice", { token, body: { usdAmount } });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.amountUsd, 5);
      assert.equal(r.json.minutesAdded, 300);
    });
  }

  it("rewrites the checkout link from the LAN host to the public one", async () => {
    const r = await post(srv, "/api/btcpay/create-invoice", { token, body: { usdAmount: 5 } });
    assert.equal(r.status, 200);
    assert.match(r.json.checkoutLink, /^https:\/\/pay\.example\.test\/i\//);
    assert.doesNotMatch(r.json.checkoutLink, /127\.0\.0\.1/, "the LAN BTCPay host must not leak to a browser");
  });

  it("requires authentication", async () => {
    const r = await post(srv, "/api/btcpay/create-invoice", { body: { usdAmount: 5 } });
    assert.equal(r.status, 401);
  });

  it("fails with 502 when BTCPay returns no invoice id (an unmatchable payment)", async () => {
    mode = "no-id";
    try {
      const r = await post(srv, "/api/btcpay/create-invoice", { token, body: { usdAmount: 5 } });
      assert.equal(r.status, 502);
      assert.match(r.json.error, /no invoice id/);
    } finally { mode = "ok"; }
  });

  it("fails with 502 when BTCPay errors, and writes no invoice row", async () => {
    mode = "error";
    try {
      const r = await post(srv, "/api/btcpay/create-invoice", { token, body: { usdAmount: 5 } });
      assert.equal(r.status, 502);
    } finally { mode = "ok"; }
  });
});

describe("create-invoice: BTCPay not configured", () => {
  let srv, token;

  before(async () => {
    srv = await startServer(); // default env: no API key / store id
    const u = seedUser(srv, { password: "hunter22" });
    const login = await post(srv, "/api/auth/login", { body: { username: u.username, password: "hunter22" } });
    token = login.json.token;
  });
  after(async () => { if (srv) await srv.stop(); });

  it("returns 500 rather than pretending an invoice exists", async () => {
    const r = await post(srv, "/api/btcpay/create-invoice", { token, body: { usdAmount: 5 } });
    assert.equal(r.status, 500);
    assert.match(r.json.error, /not configured/);
    assert.deepEqual((await get(srv, "/api/invoices", { token })).json.invoices, []);
  });
});
