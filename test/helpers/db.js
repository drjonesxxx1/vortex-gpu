// Direct access to a *throwaway* SQLite file, for seeding rows the HTTP API
// cannot (or must not) create: legacy NULL-password accounts, invoice rows that
// would otherwise require a real BTCPay call, and vm/session rows that would
// otherwise require a real KVM clone or a real GPU container.
//
// Every function here takes the harness ctx and opens ctx.dbPath, which always
// lives under a mkdtemp() directory. It is never data/vortex.db.

import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import assert from "node:assert/strict";

function open(ctx) {
  assert.ok(ctx.dbPath, "no dbPath on context");
  assert.ok(/vortex-test-/.test(ctx.dbPath), `refusing to open a db outside a test temp dir: ${ctx.dbPath}`);
  return new DatabaseSync(ctx.dbPath);
}

/** Run fn against the throwaway DB, retrying briefly if the server holds a lock. */
export function withDb(ctx, fn) {
  let lastErr;
  for (let i = 0; i < 50; i++) {
    const db = open(ctx);
    try {
      return fn(db);
    } catch (e) {
      lastErr = e;
      if (!/busy|locked/i.test(String(e?.message))) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    } finally {
      db.close();
    }
  }
  throw lastErr;
}

/** Same scrypt format the gateway stores: `${saltHex}:${hashHex}`. */
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString("hex")}`;
}

/**
 * Insert a user directly. Pass `passwordHash: null` to create the legacy
 * NULL-credential account that must never be claimable.
 */
export function seedUser(ctx, opts = {}) {
  const id = opts.id ?? "usr_" + crypto.randomBytes(8).toString("hex");
  const username = opts.username ?? `s${crypto.randomBytes(6).toString("hex")}`;
  const password = opts.password ?? "correct horse";
  const passwordHash = "passwordHash" in opts ? opts.passwordHash : hashPassword(password);
  withDb(ctx, (db) => {
    db.prepare(
      "INSERT INTO users (id,username,balance_minutes,btc_address,created_at,password_hash,unlimited) VALUES (?,?,?,?,?,?,?)",
    ).run(id, username, opts.balanceMinutes ?? 0, opts.btcAddress ?? ("bc1q" + crypto.randomBytes(16).toString("hex")),
      opts.createdAt ?? Date.now(), passwordHash, opts.unlimited ? 1 : 0);
  });
  return { id, username, password, passwordHash };
}

export function getUser(ctx, id) {
  return withDb(ctx, (db) => db.prepare("SELECT * FROM users WHERE id=?").get(id));
}

export function seedVm(ctx, opts = {}) {
  const id = opts.id ?? "vm_" + crypto.randomBytes(6).toString("hex");
  withDb(ctx, (db) => {
    db.prepare(
      "INSERT INTO vms (id,user_id,vm_id,node_hostname,name,os,sku,state,ip,port,username,password,app,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(id, opts.userId, opts.vmid ?? 9000 + Math.floor(Math.random() * 900), "proxmox.invalid",
      opts.name ?? "vortex-test", opts.os ?? "linux", opts.sku ?? "TEST GPU",
      opts.state ?? "running", opts.ip ?? null, opts.port ?? 30000 + Math.floor(Math.random() * 9000),
      "rent", "pw", "", opts.createdAt ?? Date.now());
  });
  return { id };
}

export function getVm(ctx, id) {
  return withDb(ctx, (db) => db.prepare("SELECT * FROM vms WHERE id=?").get(id));
}

export function seedSession(ctx, opts = {}) {
  const id = opts.id ?? "ses_" + crypto.randomBytes(8).toString("hex");
  const instanceId = opts.instanceId ?? "sess_" + crypto.randomBytes(16).toString("hex");
  withDb(ctx, (db) => {
    db.prepare(
      "INSERT INTO sessions (id,user_id,instance_id,node_hostname,node_ip,port,password,resolution,proxy,state,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run(id, opts.userId, instanceId, opts.nodeHostname ?? "testnode", opts.nodeIp ?? "127.0.0.1",
      opts.port ?? 6090 + Math.floor(Math.random() * 100), opts.password ?? "Ubtest!",
      opts.resolution ?? "1440x900", opts.proxy ?? null, opts.state ?? "running", opts.createdAt ?? Date.now());
  });
  return { id, instanceId };
}

export function getSession(ctx, id) {
  return withDb(ctx, (db) => db.prepare("SELECT * FROM sessions WHERE id=?").get(id));
}

export function countSessions(ctx, userId) {
  return withDb(ctx, (db) => db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE user_id=?").get(userId).c);
}

/**
 * Insert an invoice row exactly as /api/btcpay/create-invoice would, without
 * needing a BTCPay server. This is what lets the webhook tests — the
 * highest-value tests here — run with no external dependency at all.
 */
export function seedInvoice(ctx, opts = {}) {
  const id = opts.id ?? crypto.randomBytes(8).toString("hex");
  const btcpayInvoiceId = opts.btcpayInvoiceId ?? "BTC" + crypto.randomBytes(8).toString("hex");
  withDb(ctx, (db) => {
    db.prepare(
      "INSERT INTO invoices (id,user_id,amount_usd,minutes,btcpay_invoice_id,checkout_link,status,created_at,settled_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(id, opts.userId, opts.amountUsd ?? 5, opts.minutes ?? 300, btcpayInvoiceId,
      opts.checkoutLink ?? "https://btcpay.invalid/i/" + btcpayInvoiceId, opts.status ?? "pending",
      opts.createdAt ?? Date.now(), opts.settledAt ?? null);
  });
  return { id, btcpayInvoiceId, minutes: opts.minutes ?? 300 };
}

export function getInvoice(ctx, id) {
  return withDb(ctx, (db) => db.prepare("SELECT * FROM invoices WHERE id=?").get(id));
}
