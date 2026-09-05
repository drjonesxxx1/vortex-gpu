// The opt-in faster/riskier crediting mode. Its own server, because
// CREDIT_ON_PROCESSING is read once at startup.

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { useServer } from "./helpers/harness.js";
import { post } from "./helpers/http.js";
import { seedUser, seedInvoice, getInvoice, getUser } from "./helpers/db.js";

function deliver(srv, payload) {
  const rawBody = JSON.stringify(payload);
  const sig = `sha256=${crypto.createHmac("sha256", srv.webhookSecret).update(rawBody).digest("hex")}`;
  return post(srv, "/api/btcpay/webhook", { rawBody, headers: { "btcpay-sig": sig } });
}

describe("webhook: CREDIT_ON_PROCESSING=1", () => {
  const srv = useServer({ env: { CREDIT_ON_PROCESSING: "1" } });
  let user, invoice;

  before(() => {
    user = seedUser(srv, { balanceMinutes: 0 });
    invoice = seedInvoice(srv, { userId: user.id, amountUsd: 5, minutes: 300 });
  });

  it("InvoiceProcessing credits when the opt-in is on", async () => {
    const r = await deliver(srv, { type: "InvoiceProcessing", invoiceId: invoice.btcpayInvoiceId });
    assert.equal(r.status, 200);
    assert.equal(getUser(srv, user.id).balance_minutes, 300);
    assert.equal(getInvoice(srv, invoice.id).status, "settled");
  });

  it("a following InvoiceSettled for the same invoice does not credit again", async () => {
    const r = await deliver(srv, { type: "InvoiceSettled", invoiceId: invoice.btcpayInvoiceId });
    assert.equal(r.status, 200);
    assert.equal(getUser(srv, user.id).balance_minutes, 300, "Processing then Settled must credit once in total");
  });

  it("signature verification is unaffected by the opt-in", async () => {
    const u = seedUser(srv);
    const inv = seedInvoice(srv, { userId: u.id, minutes: 60 });
    const rawBody = JSON.stringify({ type: "InvoiceProcessing", invoiceId: inv.btcpayInvoiceId });
    const r = await post(srv, "/api/btcpay/webhook", { rawBody, headers: { "btcpay-sig": `sha256=${"b".repeat(64)}` } });
    assert.equal(r.status, 401);
    assert.equal(getUser(srv, u.id).balance_minutes, 0);
  });
});
