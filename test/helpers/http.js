// Thin fetch wrapper for the black-box tests.

import crypto from "node:crypto";

/**
 * A random source IP for the X-Forwarded-For header.
 *
 * The gateway's rate limits are keyed on req.ip, and `trust proxy` includes
 * loopback, so a request arriving from 127.0.0.1 with an XFF header is bucketed
 * under that address. Every request therefore gets its own bucket by default,
 * which is what makes the tests independent of each other and of ordering — the
 * register limiter is only 10/hour/IP. Tests that are *about* rate limiting pin
 * `ip` explicitly.
 *
 * 100.64.0.0/10 is CGNAT space: it is not in express's `uniquelocal` set, so it
 * is treated as an untrusted (i.e. client) address, and it is not routable.
 */
export function randomIp() {
  const b = crypto.randomBytes(3);
  return `100.64.${b[0]}.${(b[1] % 254) + 1}`;
}

export async function req(ctx, method, path, opts = {}) {
  const headers = {
    "x-forwarded-for": opts.ip ?? randomIp(),
    ...opts.headers,
  };
  let body;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
    headers["content-type"] ??= "application/json";
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] ??= "application/json";
  }
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;

  const res = await fetch(`${ctx.baseUrl}${path}`, { method, headers, body, redirect: "manual" });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: res.status, headers: res.headers, text, json };
}

export const get = (ctx, path, opts) => req(ctx, "GET", path, opts);
export const post = (ctx, path, opts) => req(ctx, "POST", path, opts);

/** Register a fresh account over HTTP and return { token, user, password }. */
export async function registerUser(ctx, overrides = {}) {
  const username = overrides.username ?? `u${crypto.randomBytes(6).toString("hex")}`;
  const password = overrides.password ?? "correct horse";
  const r = await post(ctx, "/api/auth/register", { body: { username, password }, ip: overrides.ip });
  if (r.status !== 200) throw new Error(`register failed: ${r.status} ${r.text}`);
  return { token: r.json.token, user: r.json.user, username, password };
}
