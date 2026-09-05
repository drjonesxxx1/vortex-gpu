// BTCPay webhook — the highest-value tests here. A bug in this handler either
// credits money that was never paid, or fails to credit money that was.
//
// No BTCPay server is involved: invoice rows are seeded directly into the
// throwaway DB, exactly as /api/btcpay/create-invoice would write them.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { useServer } from "./helpers/harness.js";
import { get, post } from "./helpers/http.js";
import { seedUser, seedInvoice, getInvoice, getUser } from "./helpers/db.js";

/** The signature BTCPay sends: HMAC-SHA256 over the exact request bytes. */
function sign(secret, rawBody) {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

function deliver(srv, payload, { secret = srv.webhookSecret, sig, raw, contentType } = {}) {
  const rawBody = raw ?? JSON.stringify(payload);
  const headers = { "btcpay-sig": sig ?? sign(secret, rawBody) };
  if (contentType) headers["content-type"] = contentType;
  return post(srv, "/api/btcpay/webhook", { rawBody, headers });
}

describe("webhook: signature verification", () => {
  const srv = useServer();

  it("rejects a delivery with no signature (401)", async () => {
    const r = await post(srv, "/api/btcpay/webhook", { rawBody: JSON.stringify({ type: "InvoiceSettled" }) });
    assert.equal(r.status, 401);
    assert.match(r.json.error, /missing signature/);
  });

  it("rejects a forged signature (401)", async () => {
    const r = await deliver(srv, { type: "InvoiceSettled", invoiceId: "x" }, { sig: `sha256=${"a".repeat(64)}` });
    assert.equal(r.status, 401);
    assert.match(r.json.error, /bad signature/);
  });

  it("rejects a signature made with the wrong secret (401)", async () => {
    const r = await deliver(srv, { type: "InvoiceSettled", invoiceId: "x" }, { secret: "not-the-secret" });
    assert.equal(r.status, 401);
  });

  it("rejects a truncated / wrong-length signature (401, no timingSafeEqual throw)", async () => {
    for (const sig of ["sha256=", "sha256=deadbeef", "garbage", "sha256=" + "a".repeat(63)]) {
      const r = await deliver(srv, { type: "InvoiceSettled" }, { sig });
      assert.equal(r.status, 401, `expected 401 for sig ${JSON.stringify(sig)}`);
    }
  });

  it("verifies the HMAC over the RAW bytes, not a re-serialisation", async () => {
    const canonical = JSON.stringify({ type: "InvoiceSettled", invoiceId: "abc" });
    // Semantically identical JSON, different bytes. A handler that verified a
    // re-serialised parse of the body would wrongly accept this.
    const respaced = '{ "type": "InvoiceSettled", "invoiceId": "abc" }';
    const r = await deliver(srv, null, { raw: respaced, sig: sign(srv.webhookSecret, canonical) });
    assert.equal(r.status, 401);

    const ok = await deliver(srv, null, { raw: respaced });
    assert.equal(ok.status, 200, "the same bytes, correctly signed, are accepted");
  });

  it("accepts a correctly-signed delivery (200)", async () => {
    const r = await deliver(srv, { type: "InvoiceCreated", invoiceId: "nothing-here" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { received: true });
  });

  it("refuses a body express.raw did not parse (400)", async () => {
    const r = await deliver(srv, { type: "InvoiceSettled" }, { contentType: "text/plain" });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /raw body/);
  });

  it("refuses malformed JSON that is correctly signed (400)", async () => {
    const r = await deliver(srv, null, { raw: "{not json" });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /invalid json/);
  });
});

describe("webhook: crediting (default settings)", () => {
  const srv = useServer();
  let user, invoice;

  before(() => {
    user = seedUser(srv, { balanceMinutes: 0 });
    invoice = seedInvoice(srv, { userId: user.id, amountUsd: 5, minutes: 300 });
  });

  it("InvoiceProcessing does NOT credit by default", async () => {
    const r = await deliver(srv, { type: "InvoiceProcessing", invoiceId: invoice.btcpayInvoiceId });
    assert.equal(r.status, 200, "BTCPay retries on non-2xx, so it must still be acknowledged");
    assert.equal(getUser(srv, user.id).balance_minutes, 0, "an unconfirmed payment must not buy GPU time");
    assert.equal(getInvoice(srv, invoice.id).status, "pending");
  });

  it("InvoiceSettled DOES credit, exactly once", async () => {
    const r = await deliver(srv, { type: "InvoiceSettled", invoiceId: invoice.btcpayInvoiceId });
    assert.equal(r.status, 200);
    const after = getInvoice(srv, invoice.id);
    assert.equal(after.status, "settled");
    assert.ok(after.settled_at > 0);
    assert.equal(getUser(srv, user.id).balance_minutes, 300);
  });

  it("a replayed InvoiceSettled does not double-credit", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await deliver(srv, { type: "InvoiceSettled", invoiceId: invoice.btcpayInvoiceId });
      assert.equal(r.status, 200);
    }
    assert.equal(getUser(srv, user.id).balance_minutes, 300, "replay must be idempotent");
  });

  it("an unknown invoice id is acknowledged and credits nobody", async () => {
    const before = getUser(srv, user.id).balance_minutes;
    const r = await deliver(srv, { type: "InvoiceSettled", invoiceId: "no-such-invoice" });
    assert.equal(r.status, 200);
    assert.equal(getUser(srv, user.id).balance_minutes, before);
  });

  it("non-crediting event types are acknowledged and credit nothing", async () => {
    const u = seedUser(srv);
    const inv = seedInvoice(srv, { userId: u.id, minutes: 120 });
    for (const type of ["InvoiceCreated", "InvoiceExpired", "InvoiceInvalid", "InvoiceReceivedPayment", ""]) {
      const r = await deliver(srv, { type, invoiceId: inv.btcpayInvoiceId });
      assert.equal(r.status, 200);
    }
    assert.equal(getUser(srv, u.id).balance_minutes, 0);
    assert.equal(getInvoice(srv, inv.id).status, "pending");
  });

  it("settles without crediting when the stored minutes are not a positive integer", async () => {
    for (const minutes of [0, -60, 1.5]) {
      const u = seedUser(srv);
      const inv = seedInvoice(srv, { userId: u.id, minutes });
      const r = await deliver(srv, { type: "InvoiceSettled", invoiceId: inv.btcpayInvoiceId });
      assert.equal(r.status, 200);
      assert.equal(getInvoice(srv, inv.id).status, "settled");
      assert.equal(getUser(srv, u.id).balance_minutes, 0, `minutes=${minutes} must never be credited`);
    }
  });

  it("credits only the invoice's own owner", async () => {
    const owner = seedUser(srv);
    const bystander = seedUser(srv);
    const inv = seedInvoice(srv, { userId: owner.id, minutes: 60 });
    await deliver(srv, { type: "InvoiceSettled", invoiceId: inv.btcpayInvoiceId });
    assert.equal(getUser(srv, owner.id).balance_minutes, 60);
    assert.equal(getUser(srv, bystander.id).balance_minutes, 0);
  });
});

describe("webhook: /api/invoices never exposes the BTCPay invoice id", () => {
  const srv = useServer();

  it("lists the caller's own invoices only, without btcpay_invoice_id", async () => {
    const mine = seedUser(srv, { password: "hunter22" });
    const theirs = seedUser(srv);
    // NOTE: a real checkout_link is BTCPAY_PUBLIC + "/i/" + btcpayInvoiceId, so
    // that column legitimately embeds the same id — it is the customer's own
    // payment page. Seed a link without it so the assertion below is testing
    // the SELECT column list rather than that unavoidable overlap.
    const myInv = seedInvoice(srv, {
      userId: mine.id, amountUsd: 12.5, minutes: 750, checkoutLink: "https://btcpay.invalid/checkout",
    });
    seedInvoice(srv, { userId: theirs.id, amountUsd: 99, minutes: 5940 });

    const login = await post(srv, "/api/auth/login", { body: { username: mine.username, password: "hunter22" } });
    const r = await get(srv, "/api/invoices", { token: login.json.token });
    assert.equal(r.status, 200);
    assert.equal(r.json.invoices.length, 1);
    assert.equal(r.json.invoices[0].id, myInv.id);
    assert.equal(r.json.invoices[0].amount_usd, 12.5);
    assert.ok(!("btcpay_invoice_id" in r.json.invoices[0]), "the BTCPay id has no business in a browser");
    assert.doesNotMatch(r.text, new RegExp(myInv.btcpayInvoiceId));
  });
});
