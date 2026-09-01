import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import https from "https";
import http from "http";
import { execFile } from "child_process";
import { promisify } from "util";
import { createServer as createViteServer } from "vite";
import { DatabaseSync } from "node:sqlite";
import { createProxyMiddleware } from "http-proxy-middleware";

const exec = promisify(execFile);

/**
 * VortexGPU — rent-a-PC platform (production build)
 *
 * Products (unified storefront):
 *   - Ubuntu GPU Session (in-browser desktop, 4080 SUPER attached, noVNC)
 *   - Windows 10 (RDP)  : clone template 504 (comandoVM)
 *   - Linux (SSH)       : clone template 990 (vortex-linux-tpl)
 * Pricing: $1/hr flat. FIRST machine free per account; the 2nd and 3rd bill.
 *   Sessions are metered exactly like VMs (no more free sessions).
 * Auth: token-based register/login/logout (everyone gets their own account).
 * Proxies: ProxyFly clean residential pool refreshed in the background and
 *   auto-assigned to each Ubuntu session on spawn.
 * Payments: BTCPay (real invoices + HMAC-signed webhook settlement).
 * Admin: /admin?token= (404 without token) + /api/admin/* (Bearer).
 */

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString("hex");
const NODE_SECRET = process.env.NODE_SECRET || crypto.randomBytes(24).toString("hex");
// Express `trust proxy` setting. Public traffic reaches this box through
// Cloudflare and then the LAN, so X-Forwarded-For MUST still be honoured for
// those requests — but only when the immediate peer is one of ours. The
// 'loopback, linklocal, uniquelocal' shorthand trusts 127.0.0.1/::1, link-local
// and private ranges (10/8 included) and nothing else, so a client connecting
// straight from the internet can no longer forge its own rate-limit key.
// Override with TRUST_PROXY (a hop count, `true`/`false`, or a CSV of
// subnets/shorthands) if the deployment topology changes.
function trustProxySetting(raw: string): string | number | boolean {
  const v = raw.trim();
  if (/^\d+$/.test(v)) return Number(v);
  if (v.toLowerCase() === "true") return true;
  if (v.toLowerCase() === "false") return false;
  return v;
}
const TRUST_PROXY = trustProxySetting(str(process.env.TRUST_PROXY, "loopback, linklocal, uniquelocal"));

// ---- Proxmox ----
const PVE_HOST = process.env.PVE_HOST || "10.30.20.85";
const PVE_USER = process.env.PVE_USER || "root";
const PVE_TEMPLATE_WIN = Number(process.env.PVE_TEMPLATE_WIN) || 504;
const PVE_TEMPLATE_LINUX = Number(process.env.PVE_TEMPLATE_LINUX) || 990;
const PVE_VMID_START = Number(process.env.PVE_VMID_START) || 2000;
// Names shown to tenants for the guest each template actually produces. The UI
// reads these from /api/health rather than hardcoding a version, so swapping
// PVE_TEMPLATE_WIN/LINUX to a different image cannot leave the storefront
// advertising an OS the tenant does not get.
const WINDOWS_LABEL = process.env.WINDOWS_LABEL || "Windows";
const LINUX_LABEL = process.env.LINUX_LABEL || "Linux";

// ---- BTCPay ----
const BTCPAY_URL = process.env.BTCPAY_URL || "https://10.30.20.140";
const BTCPAY_API_KEY = process.env.BTCPAY_API_KEY || "";
const BTCPAY_STORE_ID = process.env.BTCPAY_STORE_ID || "";
const BTCPAY_PUBLIC = process.env.BTCPAY_PUBLIC || "https://btcpay.thetempleofdoom.com";
const WEBHOOK_SECRET = process.env.BTCPAY_WEBHOOK_SECRET || "";
if (!WEBHOOK_SECRET) throw new Error("BTCPAY_WEBHOOK_SECRET is required; refusing to start with an unsigned-webhook fallback");
const OWNER_SEED_PASSWORD = process.env.OWNER_SEED_PASSWORD || "";
// InvoiceProcessing means BTCPay has SEEN a payment, not that it is confirmed —
// a replaced/double-spent transaction still fires it. Crediting on it hands out
// GPU time for money that may never arrive, so settlement is the default and the
// faster, riskier behaviour is opt-in via CREDIT_ON_PROCESSING=1.
const CREDIT_ON_PROCESSING = process.env.CREDIT_ON_PROCESSING === "1";
const PRICE_USD_PER_HOUR = 1.0;
const MAX_INVOICE_CENTS = 1_000_000; // $10,000 ceiling on a single top-up
// A tenant session is advertised as a GPU machine. Handing one out on a node
// whose VRAM is already consumed by another workload gives them a desktop that
// cannot run anything on the GPU — while still billing them. Refuse instead.
// Set to 0 to disable the preflight.
const MIN_FREE_VRAM_MB = Number.isFinite(Number(process.env.MIN_FREE_VRAM_MB)) ? Number(process.env.MIN_FREE_VRAM_MB) : 2048;
// The only node running the Linux docker/noVNC session agent. Health and spawn
// MUST agree on this, or health advertises capacity sessions cannot use.
const SESSION_NODE = process.env.SESSION_NODE || "nightmare";
const MAX_VMS_PER_USER = 3;
const FREE_MACHINES = Number(process.env.FREE_MACHINES) || 1; // 1st machine free, 2nd+ billed

// Marketing tier label (what tenants see) — configurable, decoupled from truth.
const GPU_SKU = process.env.GPU_SKU || "NVIDIA GeForce RTX 4080 SUPER 16GB";

// ---- GPU node registry (in-memory; agents phone home) ----
type GpuNode = {
  hostname: string;
  ip: string;
  gpuModel: string;
  driverVersion: string;
  memTotalMb: number;
  memUsedMb: number;
  gpuUtilPct: number;
  tempC: number;
  cpuUtilPct: number;
  ramTotalGb: number;
  ramUsedGb: number;
  uptimeSec: number;
  lastSeen: number;
};

type GpuJob = {
  id: string;
  hostname: string;
  kind: "shell" | "hashcat" | "comfyui" | "provision_ubuntu" | "destroy_ubuntu";
  command: string;
  payload: Record<string, unknown>;
  status: "pending" | "running" | "done" | "failed";
  result: string;
  createdAt: number;
  completedAt: number | null;
};

const DATA_DIR = path.join(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const NODES_FILE = path.join(DATA_DIR, "nodes.json");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");

function loadJson<T>(f: string, fb: T): T { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } }
function saveJson(f: string, d: unknown) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

const nodes: Record<string, GpuNode> = loadJson(NODES_FILE, {});
const jobs: GpuJob[] = loadJson(JOBS_FILE, []);
function persistNodes() { saveJson(NODES_FILE, nodes); }
function persistJobs() { saveJson(JOBS_FILE, jobs); }

// A node is "online" if it phoned home in the last 30s — that short window drives
// spawn eligibility and the admin online/offline badge and is deliberately left
// alone. Separately, a node that has not reported in a WEEK is gone for good
// (renamed host, decommissioned box, a one-off registration that never came
// back) and must stop inflating the advertised fleet size. Prune it.
const NODE_ONLINE_MS = 30_000;
const NODE_STALE_MS = Math.max(60_000, num(process.env.NODE_STALE_MS, 7 * 24 * 60 * 60 * 1000));
function isStaleNode(n: GpuNode, now = Date.now()): boolean { return now - n.lastSeen > NODE_STALE_MS; }
function pruneStaleNodes(): number {
  const now = Date.now();
  let pruned = 0;
  for (const [hostname, n] of Object.entries(nodes)) {
    if (!isStaleNode(n, now)) continue;
    delete nodes[hostname];
    pruned++;
    console.warn(`[nodes] pruned stale node ${hostname} (last seen ${new Date(n.lastSeen).toISOString()})`);
  }
  if (pruned) persistNodes();
  return pruned;
}

function num(v: unknown, fb: number): number { const n = Number(v); return Number.isFinite(n) ? n : fb; }
function str(v: unknown, fb: string): string { return typeof v === "string" && v.length ? v : fb; }
function normHost(v: unknown): string { return str(v, "").toLowerCase().trim(); }
// Hostnames are used as keys into the `nodes` object. Restricting the charset
// keeps "__proto__"/"constructor" out of that assignment as well as keeping the
// registry readable.
const HOSTNAME_RE = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
function validHost(h: string): boolean { return HOSTNAME_RE.test(h); }

// ---- SQLite ----
const db = new DatabaseSync(path.join(DATA_DIR, "vortex.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
    balance_minutes INTEGER NOT NULL DEFAULT 0, btc_address TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS vms (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
    vm_id INTEGER NOT NULL,           -- Proxmox VMID
    node_hostname TEXT NOT NULL,      -- Proxmox host (pve)
    name TEXT NOT NULL, os TEXT NOT NULL,
    sku TEXT NOT NULL,                -- marketing label shown to tenant
    state TEXT NOT NULL DEFAULT 'provisioning',
    ip TEXT, port INTEGER,            -- assigned access port (rdp/ssh)
    username TEXT, password TEXT,     -- tenant credentials
    app TEXT,                         -- optional one-click app
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
    amount_usd REAL NOT NULL, minutes INTEGER NOT NULL,
    btcpay_invoice_id TEXT, checkout_link TEXT,
    status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, settled_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
    instance_id TEXT NOT NULL UNIQUE, node_hostname TEXT NOT NULL,
    node_ip TEXT NOT NULL, port INTEGER NOT NULL, password TEXT NOT NULL,
    resolution TEXT, proxy TEXT,      -- clean ProxyFly proxy (auto-assigned)
    state TEXT NOT NULL DEFAULT 'provisioning',
    created_at INTEGER NOT NULL
  );
`);

// ---- Migrations (add columns that predate password/unlimited/proxy) ----
function ensureColumn(table: string, col: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c: any) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn("users", "password_hash", "password_hash TEXT");
ensureColumn("users", "unlimited", "unlimited INTEGER NOT NULL DEFAULT 0");
ensureColumn("sessions", "proxy", "proxy TEXT");

function q(sql: string, ...p: (string | number)[]) { return db.prepare(sql).run(...p); }
function one<T>(sql: string, ...p: (string | number)[]): T | undefined { return db.prepare(sql).get(...p) as T | undefined; }
function all<T>(sql: string, ...p: (string | number)[]): T[] { return db.prepare(sql).all(...p) as T[]; }

// ---- Password hashing (scrypt) ----
const MAX_PASSWORD_LEN = 200;
function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(pw: string, stored: string): boolean {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  try {
    const h = crypto.scryptSync(pw, salt, 32);
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), h);
  } catch { return false; }
}

// Seed the owner account (username: drjones, unlimited machines).
// Password comes from OWNER_SEED_PASSWORD; seeding is skipped if unset.
(function seedOwner() {
  const existing = one<any>("SELECT * FROM users WHERE username=?", "drjones");
  if (!existing && !OWNER_SEED_PASSWORD) { console.warn("[auth] OWNER_SEED_PASSWORD unset - skipping owner seed"); return; }
  if (!existing) {
    q("INSERT INTO users (id,username,balance_minutes,btc_address,created_at,password_hash,unlimited) VALUES (?,?,?,?,?,?,?)",
      "usr_drjones", "drjones", 1_000_000_000, "bc1q" + crypto.randomBytes(16).toString("hex"), Date.now(), hashPassword(OWNER_SEED_PASSWORD), 1);
    console.log("[auth] seeded owner account: drjones (unlimited)");
  } else if (!existing.unlimited) {
    q("UPDATE users SET unlimited=1 WHERE id=?", existing.id);
  }
})();

// ---- Proxmox driver (SSH -> qm) ----
function pve(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    exec("ssh", ["-o", "ConnectTimeout=15", "-o", "StrictHostKeyChecking=no", `${PVE_USER}@${PVE_HOST}`, ...args], { timeout: 900000, maxBuffer: 10 * 1024 * 1024 })
      .then(({ stdout, stderr }) => resolve({ ok: true, out: stdout + stderr }))
      .catch((e) => resolve({ ok: false, out: String(e.stderr || e.message || e) }));
  });
}

function nextVmid(): number {
  const row = one<{ max_id: number | null }>("SELECT MAX(vm_id) as max_id FROM vms WHERE vm_id >= ?", PVE_VMID_START);
  return (row?.max_id ?? PVE_VMID_START - 1) + 1;
}

async function cloneVm(template: number, vmid: number, name: string): Promise<{ ok: boolean; out: string }> {
  // Long-running (250GB full clone). Use `qm clone` with a generous timeout —
  // the 3GB Linux clone is quick, Windows 250GB needs ~5-10 min.
  const r = await pve(["qm", "clone", String(template), String(vmid), "--name", name, "--full"]);
  return r;
}

async function startVm(vmid: number): Promise<{ ok: boolean; out: string }> {
  return pve(["qm", "start", String(vmid)]);
}
async function stopVm(vmid: number): Promise<{ ok: boolean; out: string }> {
  return pve(["qm", "shutdown", String(vmid)]);
}
// Reclaim a guest and its disks when a tenant deletes their machine. Without
// this, delete removed only the DB row and left a real KVM guest (up to 250GB
// for a Windows clone) stranded on the host forever -- untracked and unbilled.
async function reclaimVm(vmid: number): Promise<{ ok: boolean; out: string }> {
  return pve(["qm", "destroy", String(vmid), "--purge", "--skiplock"]);
}

// How often to re-read the host and correct drifted vm rows, and how old a row
// must be before it is eligible (so a clone still in flight is never touched).
const VM_RECONCILE_MS = Math.max(60_000, num(process.env.VM_RECONCILE_MS, 5 * 60_000));
const VM_RECONCILE_MIN_AGE_MS = 15 * 60_000;

// The vms table is only written when a request happens, so it drifts from the
// host. Re-read `qm list` and correct the record. Conservative by design: only
// ever UPDATEs `state`, never deletes a row, never changes anything on the host.
async function reconcileVms(): Promise<void> {
  const r = await pve(["qm", "list"]);
  if (!r.ok) { console.warn("[reconcile] qm list failed; leaving vm states untouched"); return; }
  const onHost = new Map<number, string>();
  for (const line of r.out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+\S+\s+(\w+)/);
    if (m) onHost.set(Number(m[1]), m[2].toLowerCase());
  }
  if (onHost.size === 0) { console.warn("[reconcile] no parseable guests; skipping"); return; }
  const cutoff = Date.now() - VM_RECONCILE_MIN_AGE_MS;
  const rows = all<any>("SELECT id, vm_id, state, created_at FROM vms WHERE state NOT IN ('provisioning','stopping')");
  let fixed = 0;
  for (const row of rows) {
    if (Number(row.created_at) > cutoff) continue;
    const hostState = onHost.get(Number(row.vm_id));
    const want = hostState === undefined ? "failed" : hostState === "running" ? "running" : "stopped";
    if (want !== String(row.state)) {
      q("UPDATE vms SET state=? WHERE id=?", want, row.id);
      console.log(`[reconcile] ${row.id} (vmid ${row.vm_id}): ${row.state} -> ${want}`);
      fixed++;
    }
  }
  if (fixed) console.log(`[reconcile] corrected ${fixed} vm row(s)`);
}
async function vmStatus(vmid: number): Promise<string> {
  const r = await pve(["qm", "status", String(vmid)]);
  const m = r.out.match(/status:\s*(\w+)/);
  return m ? m[1] : "unknown";
}

// Allocate a unique public access port per VM (RDP 3389 / SSH 22 mapped to 30000+).
// Walk the range from a random start and wrap, so the search stays inside the
// range instead of incrementing off the end of it. Returns null when every port
// is taken — the caller must surface that, never hand out a duplicate.
const VM_PORT_MIN = 30000;
const VM_PORT_MAX = 49999;
function allocatePort(): number | null {
  const used = new Set(all<{ port: number }>("SELECT port FROM vms WHERE port IS NOT NULL").map((r) => r.port));
  const span = VM_PORT_MAX - VM_PORT_MIN + 1;
  const start = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const p = VM_PORT_MIN + ((start + i) % span);
    if (!used.has(p)) return p;
  }
  return null;
}

// One-click noVNC URL for a session. The container (novnc2 image) serves the
// full noVNC client at /static/vnc.html — there is NO /vnc.html at the root.
// host/port/encrypt default to window.location in noVNC, so this URL works
// identically via the gateway and the public tunnel; only `path` must point
// back through the gateway's /session/<id>/ prefix for the websocket.
function desktopUrlFor(instanceId: string, password: string): string {
  return `/session/${instanceId}/static/vnc.html?autoconnect=true&resize=scale`
    + `&path=${encodeURIComponent(`session/${instanceId}/websockify`)}`
    + `&password=${encodeURIComponent(password)}`;
}

// Allocate a session (noVNC) port from a dedicated range, distinct from VM ports.
// The old loop stopped at 6190 and returned it even when it was already taken,
// so an exhausted range silently handed two live sessions the same port. Return
// null instead and let the caller refuse the spawn.
const SESSION_PORT_MIN = 6090;
const SESSION_PORT_MAX = 6190;
function allocateSessionPort(): number | null {
  const used = new Set(all<{ port: number }>("SELECT port FROM sessions WHERE port IS NOT NULL").map((r) => r.port));
  for (let p = SESSION_PORT_MIN; p <= SESSION_PORT_MAX; p++) if (!used.has(p)) return p;
  return null;
}

// Enqueue a GPU job for a node to pick up on its next poll.
function dispatchJob(hostname: string, kind: GpuJob["kind"], command: string, payload: Record<string, unknown>): GpuJob {
  const job: GpuJob = { id: "job_" + crypto.randomBytes(6).toString("hex"), hostname, kind, command, payload, status: "pending", result: "", createdAt: Date.now(), completedAt: null };
  jobs.push(job); trimJobs(); persistJobs();
  return job;
}

// The jobs log is append-only in memory AND on disk. Keep it bounded (the admin
// view only ever shows the last 50) so it cannot grow until the disk fills.
const MAX_JOBS = 500;
function trimJobs() { if (jobs.length > MAX_JOBS) jobs.splice(0, jobs.length - MAX_JOBS); }

// ---- auth helpers ----
// Constant-time secret comparison — a plain `===` on a shared secret leaks its
// prefix through response timing.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
function nodeAuthorized(req: express.Request) { return safeEqual(String(req.headers["x-node-secret"] || ""), NODE_SECRET); }
function adminAuthorized(req: express.Request) { return safeEqual(String(req.headers["authorization"] || ""), `Bearer ${ADMIN_TOKEN}`); }

// ---- User auth tokens (in-memory; issued on login/register) ----
// Deliberately NOT persisted: the only durable store here is the live customer
// SQLite file, and a restart-surviving bearer table is not worth the extra write
// path / revocation surface. Consequence (unchanged from before): a process
// restart logs everyone out. What IS new is a hard expiry, so a leaked or
// scraped token stops being valid forever.
const TOKEN_TTL_MS = Math.max(60_000, num(process.env.AUTH_TOKEN_TTL_MS, 7 * 24 * 60 * 60 * 1000));
type AuthToken = { userId: string; expiresAt: number };
const AUTH_TOKENS = new Map<string, AuthToken>(); // token -> {userId, expiresAt}

function issueToken(userId: string): string {
  const token = crypto.randomBytes(32).toString("hex");
  AUTH_TOKENS.set(token, { userId, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}
// Revoke every live token for a user, optionally sparing one (the caller's, so a
// password change does not log the tab out of the session that just did it).
// Deleting from a Map while iterating it is well-defined; entries removed before
// they are reached are simply not visited.
function revokeUserTokens(userId: string, keepToken?: string): number {
  let revoked = 0;
  for (const [t, e] of AUTH_TOKENS) {
    if (e.userId !== userId) continue;
    if (keepToken && t === keepToken) continue;
    AUTH_TOKENS.delete(t);
    revoked++;
  }
  return revoked;
}
function resolveToken(token: string): string | null {
  const entry = token ? AUTH_TOKENS.get(token) : undefined;
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) { AUTH_TOKENS.delete(token); return null; }
  return entry.userId;
}
// Sweep expired entries so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [t, e] of AUTH_TOKENS) if (now >= e.expiresAt) AUTH_TOKENS.delete(t);
}, 10 * 60_000);

// Sweep the node registry on boot and hourly thereafter.
pruneStaleNodes();
setInterval(pruneStaleNodes, 60 * 60_000);

function tokenFromReq(req: express.Request): string {
  const auth = String(req.headers["authorization"] || "");
  return auth.startsWith("Bearer ") ? auth.slice(7) : String(req.headers["x-auth-token"] || "");
}
function userFromReq(req: express.Request): any | null {
  const userId = resolveToken(tokenFromReq(req));
  if (!userId) return null;
  return one<any>("SELECT * FROM users WHERE id=?", userId) || null;
}

// ---- ProxyFly clean-proxy pool (background refresh + auto-assign) ----
type PoolProxy = { proxy: string; ip: string; port: number; protocol: string; location: string; anonymity: string; latencyMs: number; clean: boolean; };
let proxyPool: PoolProxy[] = [];
let proxyRefreshing = false;
const PROXY_SOURCE = "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/US/data.json";

function fetchProxies(): Promise<PoolProxy[]> {
  return new Promise((resolve) => {
    const req = https.get(PROXY_SOURCE, { headers: { "User-Agent": "VortexGPU/1.0" } }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => {
        try {
          const arr: any[] = JSON.parse(buf);
          resolve(arr.filter((p) => p?.ip && p?.port).map((p) => ({
            proxy: p.proxy || `${p.protocol}://${p.ip}:${p.port}`, ip: String(p.ip), port: Number(p.port),
            protocol: String(p.protocol || "http"), location: p.geolocation?.country || "?", anonymity: String(p.anonymity || "transparent"),
            latencyMs: 0, clean: false,
          })));
        } catch { resolve([]); }
      });
    });
    req.setTimeout(20000, () => { req.destroy(); resolve([]); });
    req.on("error", () => resolve([]));
  });
}

function testProxy(p: PoolProxy): Promise<PoolProxy | null> {
  return new Promise((resolve) => {
    if (p.protocol !== "http" && p.protocol !== "https") return resolve(null);
    const t0 = Date.now();
    const mod = p.protocol === "https" ? https : http;
    const req = mod.request({ host: p.ip, port: p.port, method: "GET", path: "http://api.ipify.org", headers: { Host: "api.ipify.org" }, timeout: 8000 }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => {
        const egressIp = b.trim();
        const clean = res.statusCode === 200 && /^\d{1,3}(\.\d{1,3}){3}$/.test(egressIp) && p.anonymity !== "transparent";
        resolve(clean ? { ...p, latencyMs: Date.now() - t0, clean: true } : null);
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function refreshProxyPool() {
  if (proxyRefreshing) return;
  proxyRefreshing = true;
  try {
    const list = await fetchProxies();
    const candidates = list.filter((p) => p.anonymity === "elite" || p.anonymity === "anonymous").slice(0, 100);
    const results = await Promise.all(candidates.map(testProxy));
    proxyPool = results.filter((p): p is PoolProxy => !!p);
    console.log(`[proxy] pool refreshed: ${proxyPool.length} clean / ${list.length} fetched`);
  } catch (e) { console.error("[proxy]", e); }
  finally { proxyRefreshing = false; }
}
function assignProxy(): PoolProxy | null {
  if (!proxyPool.length) return null;
  return proxyPool[Math.floor(Math.random() * proxyPool.length)];
}

// Count a user's active machines (VMs + sessions) for the free-slot / cap.
function countActive(userId: string): number {
  const v = one<{ c: number }>("SELECT COUNT(*) as c FROM vms WHERE user_id=? AND state IN ('running','provisioning')", userId);
  const s = one<{ c: number }>("SELECT COUNT(*) as c FROM sessions WHERE user_id=? AND state IN ('running','provisioning')", userId);
  return (v?.c || 0) + (s?.c || 0);
}

// Never parse X-Forwarded-For by hand: that header is attacker-controlled and
// forging it rotated the caller around every IP-keyed rate limit below. `req.ip`
// applies the `trust proxy` setting above, so XFF counts only when the request
// actually arrived via loopback/the LAN (Cloudflare -> this box) and is ignored
// for a direct connection from the internet.
function clientIp(req: express.Request): string {
  return String(req.ip || req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}

// ---- Rate limiting (in-process fixed window; no new dependencies) ----
// NOTE on keys: clientIp() derives the key from req.ip under `trust proxy`, so
// X-Forwarded-For counts only from a trusted peer and is no longer forgeable by
// a direct caller. IP-keyed limits are still best-effort (a proxied client pool
// can share an address). The limits that actually matter for credential stuffing
// and invoice spam are keyed by username / user id, which a caller cannot rotate.
type RateBucket = { count: number; resetAt: number };
const RATE_BUCKETS = new Map<string, RateBucket>();
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of RATE_BUCKETS) if (now >= b.resetAt) RATE_BUCKETS.delete(k);
}, 60_000);

function rateLimit(name: string, limit: number, windowMs: number, keyFn?: (req: express.Request) => string): express.RequestHandler {
  return (req, res, next) => {
    const key = `${name}:${keyFn ? keyFn(req) : clientIp(req)}`;
    const now = Date.now();
    let b = RATE_BUCKETS.get(key);
    if (!b || now >= b.resetAt) { b = { count: 0, resetAt: now + windowMs }; RATE_BUCKETS.set(key, b); }
    b.count++;
    if (b.count > limit) {
      const retryAfterSec = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).json({ error: "too many requests — slow down", retryAfterSec });
    }
    next();
  };
}

// ---- Free-tier abuse limit ----
// Every new account gets FREE_MACHINES worth of unbilled capacity, so account
// creation is free GPU time and registration rate limits only slow the farming
// down. This caps how many *free* machines one source IP can take in a window.
//
// OFF BY DEFAULT (0). Enabling it can affect legitimate users who share an
// egress IP (CGNAT, an office, a VPN), so the number is yours to choose --
// nothing changes until FREE_MACHINE_IP_LIMIT is set.
const FREE_MACHINE_IP_LIMIT = Math.max(0, num(process.env.FREE_MACHINE_IP_LIMIT, 0));
const FREE_MACHINE_IP_WINDOW_MS = Math.max(60_000, num(process.env.FREE_MACHINE_IP_WINDOW_MS, 24 * 60 * 60_000));
const FREE_MACHINE_IP_BUCKETS = new Map<string, { count: number; resetAt: number }>();

// Check and record are deliberately separate: a provision that fails (node
// offline, no free ports, clone error) must not burn the caller's free-tier
// quota for the rest of the window. Only a machine that was actually handed
// out counts. Paying and unlimited accounts are never counted at all, so a
// customer with balance is unaffected.
function freeMachineDenial(req: express.Request, user: any): string | null {
  if (FREE_MACHINE_IP_LIMIT <= 0) return null;
  if (user.unlimited || Number(user.balance_minutes) > 0) return null;
  const b = FREE_MACHINE_IP_BUCKETS.get(clientIp(req));
  if (!b || Date.now() >= b.resetAt) return null;
  if (b.count >= FREE_MACHINE_IP_LIMIT) {
    console.warn(`[freetier] refused free machine for ${user.username} from ${clientIp(req)} (${b.count}/${FREE_MACHINE_IP_LIMIT} in window)`);
    return "free-tier limit reached for this network — add Bitcoin balance to deploy";
  }
  return null;
}

function recordFreeMachine(req: express.Request, user: any): void {
  if (FREE_MACHINE_IP_LIMIT <= 0) return;
  if (user.unlimited || Number(user.balance_minutes) > 0) return;
  const key = clientIp(req);
  const now = Date.now();
  let b = FREE_MACHINE_IP_BUCKETS.get(key);
  if (!b || now >= b.resetAt) { b = { count: 0, resetAt: now + FREE_MACHINE_IP_WINDOW_MS }; FREE_MACHINE_IP_BUCKETS.set(key, b); }
  b.count++;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of FREE_MACHINE_IP_BUCKETS) if (now >= b.resetAt) FREE_MACHINE_IP_BUCKETS.delete(k);
}, 60 * 60_000);

// ---- BTCPay client (self-signed LAN) ----
function btcpay(method: string, apiPath: string, body?: unknown): Promise<{ status: number; data: any }> {
  return new Promise((resolve) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = https.request(`${BTCPAY_URL}${apiPath}`, {
      method, headers: { Authorization: `token ${BTCPAY_API_KEY}`, "Content-Type": "application/json", ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}) },
      rejectUnauthorized: false,
    }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c));
      res.on("end", () => { try { resolve({ status: res.statusCode || 0, data: JSON.parse(buf || "{}") }); } catch { resolve({ status: res.statusCode || 0, data: {} }); } });
    });
    req.on("error", (e) => resolve({ status: 0, data: { error: String(e) } }));
    req.setTimeout(30000, () => { req.destroy(); resolve({ status: 0, data: { error: "timeout" } }); });
    if (data) req.write(data);
    req.end();
  });
}

async function startServer() {
  const app = express();
  app.set("trust proxy", TRUST_PROXY);
  app.use((req, res, next) => {
    if (req.method === "POST" && req.path === "/api/btcpay/webhook") return express.raw({ type: "application/json" })(req, res, next);
    express.json({ limit: "10mb" })(req, res, next);
  });

  // Dashboard/API responses are never cached (live state must always be fresh).
  app.use("/api", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

  // ===== PUBLIC =====
  app.get("/api/health", (_req, res) => {
    const now = Date.now();
    // Long-dead nodes are excluded from the advertised fleet size (and pruned by
    // the sweep above); the 30s online window is unchanged.
    const known = Object.values(nodes).filter((n) => !isStaleNode(n, now));
    const online = known.filter((n) => now - n.lastSeen < NODE_ONLINE_MS);
    const sessionNode = nodes[SESSION_NODE];
    res.json({
      status: "ok", node: "VortexGPU",
      gpuNodesOnline: online.length, gpuNodesTotal: known.length,
      // Real capacity, so the UI can show what is actually available rather than
      // implying the full card is free.
      // Report the SESSION node specifically. Aggregating across the fleet
      // advertised a Windows node's headroom for a Linux-only capability.
      windowsLabel: WINDOWS_LABEL,
      linuxLabel: LINUX_LABEL,
      sessionNode: SESSION_NODE,
      sessionNodeOnline: !!sessionNode && now - sessionNode.lastSeen < NODE_ONLINE_MS,
      gpuVramFreeMb: sessionNode ? Math.max(0, (sessionNode.memTotalMb || 0) - (sessionNode.memUsedMb || 0)) : 0,
      gpuVramTotalMb: sessionNode ? (sessionNode.memTotalMb || 0) : 0,
      minFreeVramMb: MIN_FREE_VRAM_MB,
      gpuSku: GPU_SKU, priceUsdPerHour: PRICE_USD_PER_HOUR, maxVmsPerUser: MAX_VMS_PER_USER,
      freeMachines: FREE_MACHINES,
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/api/proxy/pool", (_req, res) => {
    res.json({ count: proxyPool.length, proxies: proxyPool.slice(0, 20).map((p) => ({ ip: p.ip, location: p.location, latencyMs: p.latencyMs, anonymity: p.anonymity })) });
  });

  // ===== AUTH (register / login / logout) =====
  function publicUser(u: any) {
    return { id: u.id, username: u.username, balance_minutes: u.balance_minutes, unlimited: !!u.unlimited, free_machines: FREE_MACHINES, max_machines: MAX_VMS_PER_USER };
  }

  // Account farming is not just spam here: every new account carries a FREE
  // machine slot, so unlimited registration is unlimited free GPU time.
  app.post("/api/auth/register", rateLimit("register", 10, 60 * 60_000), (req, res) => {
    const username = str(req.body?.username, "").slice(0, 32).trim();
    const password = str(req.body?.password, "");
    if (!username) return res.status(400).json({ error: "username required" });
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return res.status(400).json({ error: "username must be 3-32 chars (letters, numbers, _ . -)" });
    if (password.length < 6) return res.status(400).json({ error: "password must be at least 6 chars" });
    if (password.length > MAX_PASSWORD_LEN) return res.status(400).json({ error: `password must be at most ${MAX_PASSWORD_LEN} chars` });
    if (one<any>("SELECT id FROM users WHERE username=?", username)) return res.status(409).json({ error: "username already taken" });

    const id = "usr_" + crypto.randomBytes(8).toString("hex");
    q("INSERT INTO users (id,username,balance_minutes,btc_address,created_at,password_hash,unlimited) VALUES (?,?,?,?,?,?,?)",
      id, username, 0, "bc1q" + crypto.randomBytes(16).toString("hex"), Date.now(), hashPassword(password), 0);
    const user = one<any>("SELECT * FROM users WHERE id=?", id);
    res.json({ token: issueToken(id), user: publicUser(user) });
  });

  // Two limiters: one best-effort per source IP, one per targeted username that
  // a distributed attacker cannot rotate around. Both also bound the cost of
  // scryptSync, which blocks the single-threaded event loop.
  app.post("/api/auth/login",
    rateLimit("login-ip", 20, 5 * 60_000),
    rateLimit("login-user", 10, 15 * 60_000, (req) => str(req.body?.username, "").slice(0, 64).trim().toLowerCase()),
    (req, res) => {
    const username = str(req.body?.username, "").slice(0, 64).trim();
    const password = str(req.body?.password, "");
    // Bound scrypt work before doing any: an unbounded password is a cheap way to
    // block the single-threaded event loop.
    if (!username || password.length > MAX_PASSWORD_LEN) return res.status(400).json({ error: "invalid credentials" });
    const user = one<any>("SELECT * FROM users WHERE username=?", username);
    if (!user) return res.status(401).json({ error: "no account with that username" });
    // A NULL/blank password_hash is a legacy account with NO credential set. It
    // must NOT be claimable: previously the first login silently adopted whatever
    // password was submitted, handing the account to any attacker who guessed the
    // username. Such accounts are locked out of this path until an operator sets
    // a hash out-of-band.
    if (!user.password_hash) return res.status(403).json({ error: "account has no password set — contact support" });
    if (!verifyPassword(password, user.password_hash)) return res.status(401).json({ error: "wrong password" });
    res.json({ token: issueToken(user.id), user: publicUser(user) });
  });

  app.post("/api/auth/logout", (req, res) => {
    const token = tokenFromReq(req);
    if (token) AUTH_TOKENS.delete(token);
    res.json({ ok: true });
  });

  // Changing a password is a credential operation and runs scryptSync twice, which
  // blocks the single-threaded event loop — rate-limit it like the other auth
  // routes, keyed by the caller's user id (which a caller cannot rotate) and
  // falling back to the source IP for unauthenticated noise.
  app.post("/api/auth/change-password",
    rateLimit("change-password", 10, 15 * 60_000, (req) => resolveToken(tokenFromReq(req)) || clientIp(req)),
    (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    const currentPassword = str(req.body?.currentPassword, "");
    const newPassword = str(req.body?.newPassword, "");
    // A NULL/blank password_hash is a legacy account with NO credential set. It is
    // locked out of /api/auth/login for the same reason it must be locked out
    // here: letting this route set the first password would hand the account to
    // whoever reached it, reopening the takeover hole closed in d6dd5d4.
    if (!user.password_hash) return res.status(403).json({ error: "account has no password set — contact support" });
    // Bound scrypt work before doing any (see /api/auth/login).
    if (currentPassword.length > MAX_PASSWORD_LEN) return res.status(401).json({ error: "wrong password" });
    if (!verifyPassword(currentPassword, user.password_hash)) return res.status(401).json({ error: "wrong password" });
    // Same rules as register.
    if (newPassword.length < 6) return res.status(400).json({ error: "password must be at least 6 chars" });
    if (newPassword.length > MAX_PASSWORD_LEN) return res.status(400).json({ error: `password must be at most ${MAX_PASSWORD_LEN} chars` });

    q("UPDATE users SET password_hash=? WHERE id=?", hashPassword(newPassword), user.id);
    // Every other bearer token for this account dies with the old password; the
    // caller's own token survives so they are not logged out of the tab they
    // just used.
    revokeUserTokens(user.id, tokenFromReq(req));
    res.json({ ok: true });
  });

  app.post("/api/auth/logout-all", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    revokeUserTokens(user.id); // includes the caller's own token
    res.json({ ok: true });
  });

  app.get("/api/me", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    const vms = all<any>("SELECT * FROM vms WHERE user_id=? ORDER BY created_at DESC", user.id);
    const sessions = all<any>("SELECT * FROM sessions WHERE user_id=? ORDER BY created_at DESC", user.id);
    res.json({
      user: { id: user.id, username: user.username, balance_minutes: user.balance_minutes, unlimited: !!user.unlimited },
      vms, sessions,
      max_machines: user.unlimited ? -1 : MAX_VMS_PER_USER,
      free_machines: user.unlimited ? MAX_VMS_PER_USER : FREE_MACHINES,
      gpu_sku: GPU_SKU, price_per_hour: PRICE_USD_PER_HOUR,
    });
  });

  // Account detail for the settings screen. Explicit column list — `users` also
  // holds password_hash, which must never leave the process.
  app.get("/api/account", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    const row = one<any>("SELECT id,username,balance_minutes,unlimited,btc_address,created_at FROM users WHERE id=?", user.id);
    if (!row) return res.status(404).json({ error: "not found" });
    res.json({ user: { id: row.id, username: row.username, balance_minutes: row.balance_minutes, unlimited: !!row.unlimited, btc_address: row.btc_address, created_at: row.created_at } });
  });

  // ===== VM PROVISIONING (real KVM clone) =====
  app.post("/api/vms/provision", async (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    const osName = str(req.body?.os, "windows");
    if (osName !== "windows" && osName !== "linux") return res.status(400).json({ error: "os must be 'windows' or 'linux'" });
    // `app` is persisted and handed to node-side tooling; keep it to a safe charset.
    const appName = str(req.body?.app, "").slice(0, 64);
    if (appName && !/^[a-zA-Z0-9_. -]+$/.test(appName)) return res.status(400).json({ error: "invalid app" });
    const unlimited = !!user.unlimited;
    const active = countActive(user.id);
    if (!unlimited && active >= FREE_MACHINES && user.balance_minutes <= 0) return res.status(402).json({ error: "insufficient balance — your first machine is free; top up with Bitcoin for more" });
    if (!unlimited && active >= MAX_VMS_PER_USER) return res.status(429).json({ error: `limit reached — max ${MAX_VMS_PER_USER} machines per account` });
    const freeDenied = freeMachineDenial(req, user);
    if (freeDenied) return res.status(402).json({ error: freeDenied });

    const isWin = osName === "windows";
    const template = isWin ? PVE_TEMPLATE_WIN : PVE_TEMPLATE_LINUX;
    const vmid = nextVmid() + Math.floor(Math.random() * 1000);
    const vmUid = "vm_" + crypto.randomBytes(6).toString("hex");
    const port = allocatePort(); // dedicated access port
    if (port === null) return res.status(503).json({ error: "no free ports — try again shortly" });
    const name = isWin ? `vortex-win-${vmid}` : `vortex-lin-${vmid}`;
    const username = isWin ? "administrator" : "rent";
    const password = "Vx" + crypto.randomBytes(6).toString("hex") + "!";

    q("INSERT INTO vms (id,user_id,vm_id,node_hostname,name,os,sku,state,port,username,password,app,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      vmUid, user.id, vmid, PVE_HOST, name, isWin ? "windows" : "linux", GPU_SKU, "provisioning", port, username, password, appName, Date.now());

    // clone + start (long-running; runs in background)
    cloneVm(template, vmid, name).then(async (r) => {
      if (!r.ok) { q("UPDATE vms SET state='failed' WHERE id=?", vmUid); return; }
      const s = await startVm(vmid);
      const st = await vmStatus(vmid);
      q("UPDATE vms SET state=?, ip=? WHERE id=?", s.ok ? "running" : st, PVE_HOST, vmUid);
    });

    recordFreeMachine(req, user);
    res.json({
      vmId: vmUid, os: isWin ? "windows" : "linux", sku: GPU_SKU, state: "provisioning",
      access: isWin ? { protocol: "rdp", host: PVE_HOST, port, username, password } : { protocol: "ssh", host: PVE_HOST, port, username, password },
      app: appName,
    });
  });

  app.post("/api/vms/destroy", async (req, res) => {
    const { vmId } = req.body || {};
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    const vm = one<any>("SELECT * FROM vms WHERE id=? AND user_id=?", str(vmId, ""), user.id);
    if (!vm) return res.status(404).json({ error: "not found" });
    q("UPDATE vms SET state='stopping' WHERE id=?", vm.id);
    await stopVm(vm.vm_id);
    q("UPDATE vms SET state='stopped' WHERE id=?", vm.id);
    res.json({ ok: true });
  });

  // Permanently forget a VM row. Deleting a row whose Proxmox VM is still alive
  // would orphan the guest (nothing left points at its VMID) and leak the host
  // resource forever, so only rows that are already terminal — 'stopped' or
  // 'failed' — may go. Anything still live or mid-transition is refused.
  const DELETABLE_STATES = ["stopped", "failed"];
  app.post("/api/vms/delete", async (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    const vmId = str(req.body?.vmId, "");
    if (!vmId) return res.status(400).json({ error: "vmId required" });
    const vm = one<any>("SELECT * FROM vms WHERE id=? AND user_id=?", vmId, user.id);
    if (!vm) return res.status(404).json({ error: "not found" });
    if (!DELETABLE_STATES.includes(String(vm.state))) return res.status(409).json({ error: "stop the machine first" });
    // Reclaim the guest BEFORE dropping the row. If the row went first and the
    // reclaim failed, the guest would be stranded with nothing left to retry
    // from. A guest that is already gone counts as success, which is also what
    // heals rows whose guest was removed by hand.
    const rec = await reclaimVm(vm.vm_id);
    if (!rec.ok && !/does not exist|no such/i.test(rec.out)) {
      console.error(`[vms] reclaim of vmid ${vm.vm_id} failed, keeping row ${vm.id}: ${rec.out.slice(0, 200)}`);
      return res.status(502).json({ error: "could not reclaim the machine on the host — nothing was deleted; try again shortly" });
    }
    // The state predicate is repeated in the DELETE (belt and braces), and
    // user_id is repeated so this can never reach another account's row.
    q("DELETE FROM vms WHERE id=? AND user_id=? AND state IN ('stopped','failed')", vm.id, user.id);
    console.log(`[vms] reclaimed vmid ${vm.vm_id} and removed row ${vm.id}`);
    res.json({ ok: true });
  });

  // ===== BTCPAY =====
  app.post("/api/btcpay/create-invoice",
    rateLimit("invoice", 20, 60 * 60_000, (req) => resolveToken(tokenFromReq(req)) || clientIp(req)),
    async (req, res) => {
    const { usdAmount } = req.body || {};
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    // Round to whole cents FIRST, then derive minutes from the exact figure that
    // is charged. Deriving minutes from the unrounded request let e.g. 5.004 be
    // billed as $5.00 while crediting for $5.004 of time, and a non-finite
    // usdAmount produced a non-integer `minutes` bound for an INTEGER column.
    const requested = Number(usdAmount);
    const cents = Math.min(MAX_INVOICE_CENTS, Math.max(100, Math.round((Number.isFinite(requested) && requested > 0 ? requested : 5) * 100)));
    const amountUsd = cents / 100;
    const minutes = Math.floor((cents * 60) / (PRICE_USD_PER_HOUR * 100));
    if (!Number.isSafeInteger(minutes) || minutes <= 0) return res.status(400).json({ error: "invalid amount" });
    if (!BTCPAY_API_KEY || !BTCPAY_STORE_ID) return res.status(500).json({ error: "BTCPay not configured" });

    const { status, data } = await btcpay("POST", `/api/v1/stores/${BTCPAY_STORE_ID}/invoices`, {
      amount: amountUsd.toFixed(2), currency: "USD", metadata: { userId: user.id, minutes },
    });
    if (status < 200 || status >= 300) return res.status(502).json({ error: data?.message || "BTCPay failed" });

    // Without a BTCPay invoice id the webhook can never match this row, so the
    // customer would pay and never be credited. Fail loudly instead.
    const btcpayInvoiceId = str(data?.id, "");
    if (!btcpayInvoiceId) return res.status(502).json({ error: "BTCPay returned no invoice id" });

    const invId = crypto.randomBytes(8).toString("hex");
    const checkoutLink = str(data?.checkoutLink, "").replace(BTCPAY_URL, BTCPAY_PUBLIC);
    q("INSERT INTO invoices (id,user_id,amount_usd,minutes,btcpay_invoice_id,checkout_link,status,created_at) VALUES (?,?,?,?,?,?,?,?)",
      invId, user.id, amountUsd, minutes, btcpayInvoiceId, checkoutLink, "pending", Date.now());
    res.json({ invoiceId: invId, btcpayInvoiceId, amountUsd, minutesAdded: minutes, checkoutLink, status: "pending" });
  });

  app.post("/api/btcpay/webhook", (req, res) => {
    const sig = String(req.headers["btcpay-sig"] || "");
    if (!sig) return res.status(401).json({ error: "missing signature" });
    // The HMAC must cover the exact bytes BTCPay signed. If express.raw did not
    // run (i.e. not application/json), there is no authentic body to verify —
    // re-serialising a parsed object would never reproduce the signed bytes, so
    // that old fallback path could only ever fail. Reject it explicitly.
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: "expected raw body" });
    const expected = `sha256=${crypto.createHmac("sha256", WEBHOOK_SECRET).update(req.body).digest("hex")}`;
    const sigBuf = Buffer.from(sig, "utf8");
    const expBuf = Buffer.from(expected, "utf8");
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return res.status(401).json({ error: "bad signature" });
    let payload: any = {};
    try { payload = JSON.parse(req.body.toString("utf8")); } catch { return res.status(400).json({ error: "invalid json" }); }

    const invoiceId = str(payload?.invoiceId, "");
    // Anything else (InvoiceCreated, InvoiceExpired, InvoiceProcessing when the
    // opt-in is off, ...) is acknowledged with 200 and ignored — BTCPay retries
    // on any non-2xx.
    const eventType = str(payload?.type, "");
    const creditable = eventType === "InvoiceSettled" || (CREDIT_ON_PROCESSING && eventType === "InvoiceProcessing");
    if (creditable && invoiceId) {
      const inv = one<any>("SELECT * FROM invoices WHERE btcpay_invoice_id=?", invoiceId);
      // Replay guard: the status flip and the credit happen in one synchronous
      // block (node:sqlite is sync, the loop is single-threaded), so a replayed
      // or duplicated delivery can never credit the same invoice twice.
      if (inv && inv.status !== "settled") {
        q("UPDATE invoices SET status='settled', settled_at=? WHERE id=?", Date.now(), inv.id);
        // Credit only a sane stored figure — never a NaN/float/negative that
        // would corrupt balance_minutes.
        const minutes = Number(inv.minutes);
        if (Number.isSafeInteger(minutes) && minutes > 0) {
          q("UPDATE users SET balance_minutes = balance_minutes + ? WHERE id=?", minutes, inv.user_id);
        } else {
          console.error(`[btcpay] invoice ${inv.id} has non-creditable minutes=${inv.minutes}; settled without credit`);
        }
      }
    }
    res.json({ received: true });
  });

  // The caller's own invoices, newest first. Scoped by user_id, and the column
  // list deliberately omits btcpay_invoice_id — that id addresses the invoice on
  // the BTCPay side and has no business in a browser.
  app.get("/api/invoices", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    const invoices = all<any>(
      "SELECT id,amount_usd,minutes,status,checkout_link,created_at,settled_at FROM invoices WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
      user.id);
    res.json({ invoices });
  });

  // ===== UBUNTU GPU SESSIONS (spawn in-browser desktop with the 4080 attached) =====
  app.post("/api/session/spawn", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    // `resolution` is forwarded verbatim in the provision_ubuntu job payload and
    // consumed by the node agent when it starts Xvfb/noVNC. Anything other than
    // WxH must never reach that side.
    const reso = str(req.body?.resolution, "1440x900");
    if (!/^\d{3,5}x\d{3,5}$/.test(reso)) return res.status(400).json({ error: "resolution must look like 1440x900" });
    const unlimited = !!user.unlimited;
    const active = countActive(user.id);
    if (!unlimited && active >= FREE_MACHINES && user.balance_minutes <= 0) return res.status(402).json({ error: "insufficient balance — your first machine is free; top up with Bitcoin for more" });
    if (!unlimited && active >= MAX_VMS_PER_USER) return res.status(429).json({ error: `limit reached — max ${MAX_VMS_PER_USER} machines per account` });
    const freeDeniedSess = freeMachineDenial(req, user);
    if (freeDeniedSess) return res.status(402).json({ error: freeDeniedSess });

    // Target the Linux GPU node (nightmare) that runs the Ubuntu-session agent.
    const hostname = SESSION_NODE;
    const node = nodes[hostname];
    if (!node || Date.now() - node.lastSeen > 30_000) {
      return res.status(503).json({ error: "GPU node offline — try again shortly" });
    }
    // Capacity preflight against real nvidia-smi telemetry from the node.
    const freeVramMb = Math.max(0, (node.memTotalMb || 0) - (node.memUsedMb || 0));
    if (MIN_FREE_VRAM_MB > 0 && node.memTotalMb > 0 && freeVramMb < MIN_FREE_VRAM_MB) {
      return res.status(503).json({ error: `GPU at capacity — ${freeVramMb} MiB VRAM free, ${MIN_FREE_VRAM_MB} MiB required. Nothing was charged; try again shortly.` });
    }

    // The /session/<instanceId>/ proxy is necessarily unauthenticated (noVNC
    // loads it as a top-level iframe navigation with no Authorization header),
    // so the instance id IS the capability. 4 bytes was guessable; use 16.
    const instanceId = "sess_" + crypto.randomBytes(16).toString("hex");
    const port = allocateSessionPort();
    if (port === null) return res.status(503).json({ error: "no free ports — try again shortly" });
    const password = "Ub" + crypto.randomBytes(6).toString("hex") + "!";
    const id = "ses_" + crypto.randomBytes(8).toString("hex");
    const proxy = assignProxy(); // clean ProxyFly proxy, auto-assigned in background

    q("INSERT INTO sessions (id,user_id,instance_id,node_hostname,node_ip,port,password,resolution,proxy,state,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      id, user.id, instanceId, hostname, node.ip, port, password, reso, proxy?.proxy ?? null, "provisioning", Date.now());
    dispatchJob(hostname, "provision_ubuntu", "", { instanceId, port, password, resolution: reso, proxy: proxy?.proxy ?? null });

    recordFreeMachine(req, user);
    res.json({ id, instanceId, port, password, resolution: reso, proxy: proxy?.proxy ?? null, state: "provisioning", url: `/session/${instanceId}/`, desktopUrl: desktopUrlFor(instanceId, password) });
  });

  app.get("/api/sessions", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    res.json(all<any>("SELECT * FROM sessions WHERE user_id=? ORDER BY created_at DESC", user.id));
  });

  app.post("/api/session/destroy", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    const sess = one<any>("SELECT * FROM sessions WHERE id=? AND user_id=?", str(req.body?.sessionId, ""), user.id);
    if (!sess) return res.status(404).json({ error: "not found" });
    q("UPDATE sessions SET state='stopping' WHERE id=?", sess.id);
    dispatchJob(sess.node_hostname, "destroy_ubuntu", "", { instanceId: sess.instance_id });
    res.json({ ok: true });
  });

  // Same contract as /api/vms/delete: a live or provisioning session still has a
  // container on a GPU node, and dropping the row is the only handle we have on
  // it. Terminal rows only.
  app.post("/api/session/delete", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    const sessionId = str(req.body?.sessionId, "");
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    const sess = one<any>("SELECT * FROM sessions WHERE id=? AND user_id=?", sessionId, user.id);
    if (!sess) return res.status(404).json({ error: "not found" });
    if (!DELETABLE_STATES.includes(String(sess.state))) return res.status(409).json({ error: "stop the machine first" });
    q("DELETE FROM sessions WHERE id=? AND user_id=? AND state IN ('stopped','failed')", sess.id, user.id);
    res.json({ ok: true });
  });

  // ===== GPU NODE LAYER =====
  app.post("/api/node/register", (req, res) => {
    if (!nodeAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
    const hostname = normHost(req.body?.hostname);
    if (!validHost(hostname)) return res.status(400).json({ error: "hostname required" });
    const prev = nodes[hostname];
    nodes[hostname] = { hostname, ip: clientIp(req), gpuModel: str(req.body?.gpuModel, prev?.gpuModel ?? "GPU"), driverVersion: str(req.body?.driverVersion, prev?.driverVersion ?? ""), memTotalMb: num(req.body?.memTotalMb, prev?.memTotalMb ?? 0), memUsedMb: prev?.memUsedMb ?? 0, gpuUtilPct: prev?.gpuUtilPct ?? 0, tempC: prev?.tempC ?? 0, cpuUtilPct: prev?.cpuUtilPct ?? 0, ramTotalGb: num(req.body?.ramTotalGb, prev?.ramTotalGb ?? 0), ramUsedGb: prev?.ramUsedGb ?? 0, uptimeSec: prev?.uptimeSec ?? 0, lastSeen: Date.now() };
    persistNodes();
    res.json({ ok: true });
  });

  app.post("/api/node/report", (req, res) => {
    if (!nodeAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
    const b = req.body || {}; const hostname = normHost(b.hostname);
    if (!validHost(hostname)) return res.status(400).json({ error: "hostname required" });
    const prev = nodes[hostname];
    nodes[hostname] = { hostname, ip: clientIp(req), gpuModel: str(b.gpuModel, prev?.gpuModel ?? "GPU"), driverVersion: str(b.driverVersion, prev?.driverVersion ?? ""), memTotalMb: num(b.memTotalMb, prev?.memTotalMb ?? 0), memUsedMb: num(b.memUsedMb, prev?.memUsedMb ?? 0), gpuUtilPct: num(b.gpuUtilPct, prev?.gpuUtilPct ?? 0), tempC: num(b.tempC, prev?.tempC ?? 0), cpuUtilPct: num(b.cpuUtilPct, prev?.cpuUtilPct ?? 0), ramTotalGb: num(b.ramTotalGb, prev?.ramTotalGb ?? 0), ramUsedGb: num(b.ramUsedGb, prev?.ramUsedGb ?? 0), uptimeSec: num(b.uptimeSec, prev?.uptimeSec ?? 0), lastSeen: Date.now() };
    persistNodes();
    res.json({ ok: true });
  });

  app.get("/api/node/jobs", (req, res) => {
    if (!nodeAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
    const hostname = normHost(req.query.hostname);
    const pending = jobs.filter((j) => j.status === "pending" && (!hostname || j.hostname === hostname)).slice(0, 5);
    for (const j of pending) j.status = "running";
    if (pending.length) persistJobs();
    res.json({ jobs: pending.map((j) => ({ id: j.id, hostname: j.hostname, kind: j.kind, command: j.command, payload: j.payload })) });
  });

  app.post("/api/node/jobs/:id/result", (req, res) => {
    if (!nodeAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
    const job = jobs.find((j) => j.id === req.params.id);
    if (!job) return res.status(404).json({ error: "not found" });
    job.status = req.body?.ok ? "done" : "failed";
    job.result = String(req.body?.result ?? "").slice(0, 64 * 1024); // bound jobs.json growth
    job.completedAt = Date.now();
    // Reflect provisioning result onto the session row.
    const p = job.payload as any;
    if (job.kind === "provision_ubuntu" && p?.instanceId) {
      q("UPDATE sessions SET state=? WHERE instance_id=?", req.body?.ok ? "running" : "failed", p.instanceId);
    } else if (job.kind === "destroy_ubuntu" && p?.instanceId) {
      q("UPDATE sessions SET state='stopped' WHERE instance_id=?", p.instanceId);
    }
    persistJobs();
    res.json({ ok: true });
  });

  // ===== ADMIN (hidden) =====
  app.get("/admin", (req, res) => {
    if (!safeEqual(str(req.query.token, ""), ADMIN_TOKEN)) return res.status(404).send("Not found");
    res.sendFile(path.join(process.cwd(), "dist", "admin.html"));
  });

  app.get("/api/admin/state", (req, res) => {
    if (!adminAuthorized(req)) return res.status(404).json({ error: "not found" });
    res.json({
      nodes: Object.values(nodes).map((n) => ({ ...n, status: Date.now() - n.lastSeen < 30_000 ? "online" : "offline" })),
      jobs: jobs.slice(-50).reverse(),
      vms: all<any>("SELECT * FROM vms ORDER BY created_at DESC"),
      users: all<any>("SELECT id,username,balance_minutes,unlimited,created_at FROM users ORDER BY created_at DESC"),
      invoices: all<any>("SELECT * FROM invoices ORDER BY created_at DESC LIMIT 50"),
      // NOTE: `adminToken` was removed from this response. The caller must already
      // hold ADMIN_TOKEN to reach this route, so echoing it back bought nothing and
      // pushed the long-lived admin secret into browser memory, history, logs and
      // any error/telemetry sink that captures API responses.
      proxyPool: proxyPool.slice(0, 20).map((p) => ({ ip: p.ip, location: p.location, latencyMs: p.latencyMs })),
    });
  });

  app.post("/api/admin/gpu/run", (req, res) => {
    if (!adminAuthorized(req)) return res.status(404).json({ error: "not found" });
    // This endpoint is remote code execution on a GPU host by design. The gate is
    // ADMIN_TOKEN (now compared in constant time); everything below just stops a
    // malformed body from parking a non-string command in jobs.json forever.
    const hostname = normHost(req.body?.hostname);
    const command = str(req.body?.command, "");
    if (!hostname || !command) return res.status(400).json({ error: "hostname and command required" });
    if (command.length > 4096) return res.status(400).json({ error: "command too long" });
    if (!nodes[hostname]) return res.status(404).json({ error: "unknown node" });
    console.warn(`[admin] shell job dispatched to ${hostname} from ${clientIp(req)}`);
    const job: GpuJob = { id: "job_" + crypto.randomBytes(6).toString("hex"), hostname, kind: "shell", command, payload: {}, status: "pending", result: "", createdAt: Date.now(), completedAt: null };
    jobs.push(job); trimJobs(); persistJobs();
    res.json({ ok: true, jobId: job.id });
  });

  // Operator password reset. d6dd5d4 correctly made a NULL/blank password_hash a
  // hard 403 on login and change-password, but left the affected legacy accounts
  // with no recovery path at all. This is that path — and it MUST work when
  // password_hash is NULL, which is its entire purpose. It is safe here precisely
  // because it is gated on ADMIN_TOKEN rather than on possession of the account.
  app.post("/api/admin/set-password", (req, res) => {
    if (!adminAuthorized(req)) return res.status(404).json({ error: "not found" });
    const userId = str(req.body?.userId, "");
    const username = str(req.body?.username, "").slice(0, 64).trim();
    const newPassword = str(req.body?.newPassword, "");
    if (!userId && !username) return res.status(400).json({ error: "username or userId required" });
    // Same rules as register.
    if (newPassword.length < 6) return res.status(400).json({ error: "password must be at least 6 chars" });
    if (newPassword.length > MAX_PASSWORD_LEN) return res.status(400).json({ error: `password must be at most ${MAX_PASSWORD_LEN} chars` });
    const user = userId
      ? one<any>("SELECT * FROM users WHERE id=?", userId)
      : one<any>("SELECT * FROM users WHERE username=?", username);
    if (!user) return res.status(404).json({ error: "user not found" });

    q("UPDATE users SET password_hash=? WHERE id=?", hashPassword(newPassword), user.id);
    // Whoever held a token for this account before the reset should not keep it.
    const revoked = revokeUserTokens(user.id);
    console.warn(`[admin] password set for ${user.username} (${user.id}) from ${clientIp(req)}; ${revoked} token(s) revoked`);
    res.json({ ok: true });
  });

  app.post("/api/admin/credit", (req, res) => {
    if (!adminAuthorized(req)) return res.status(404).json({ error: "not found" });
    const userId = str(req.body?.userId, "");
    const minutes = Math.trunc(num(req.body?.minutes, 0));
    if (!userId) return res.status(400).json({ error: "userId required" });
    // balance_minutes is an INTEGER column; a float or NaN here would corrupt it.
    if (!Number.isSafeInteger(minutes) || Math.abs(minutes) > 10_000_000) return res.status(400).json({ error: "invalid minutes" });
    if (!one<any>("SELECT id FROM users WHERE id=?", userId)) return res.status(404).json({ error: "user not found" });
    q("UPDATE users SET balance_minutes = MAX(0, balance_minutes + ?) WHERE id=?", minutes, userId);
    res.json({ ok: true });
  });

  // ===== BILLING ($1/hr, tick every minute, first machine free, auto-stop at 0) =====
  setInterval(() => {
    try {
      const runningVms = all<any>("SELECT * FROM vms WHERE state='running'");
      const runningSessions = all<any>("SELECT * FROM sessions WHERE state='running'");
      const perUser = new Map<string, number>();
      for (const r of runningVms) perUser.set(r.user_id, (perUser.get(r.user_id) || 0) + 1);
      for (const s of runningSessions) perUser.set(s.user_id, (perUser.get(s.user_id) || 0) + 1);
      for (const [userId, total] of perUser) {
        const acct = one<any>("SELECT unlimited, balance_minutes FROM users WHERE id=?", userId);
        if (!acct || acct.unlimited) continue; // unlimited accounts never bill or auto-stop
        const billable = Math.max(0, total - FREE_MACHINES); // first machine free
        if (billable <= 0) continue;
        q("UPDATE users SET balance_minutes = MAX(0, balance_minutes - ?) WHERE id=?", billable, userId);
        const u = one<any>("SELECT balance_minutes FROM users WHERE id=?", userId);
        if (u && u.balance_minutes <= 0) {
          for (const r of runningVms.filter((x) => x.user_id === userId)) {
            q("UPDATE vms SET state='stopping' WHERE id=?", r.id);
            stopVm(r.vm_id).then(() => q("UPDATE vms SET state='stopped' WHERE id=?", r.id));
          }
          for (const s of runningSessions.filter((x) => x.user_id === userId)) {
            q("UPDATE sessions SET state='stopping' WHERE id=?", s.id);
            dispatchJob(s.node_hostname, "destroy_ubuntu", "", { instanceId: s.instance_id });
          }
        }
      }
    } catch (e) { console.error("[billing]", e); }
  }, 60_000);

  // ===== SESSION noVNC PROXY (WebSocket-capable, branded failure pages) =====
  // Branded VortexGPU page shown instead of raw proxy errors — dark theme to
  // match the landing aesthetic (#05070d, cyan accents).
  function vortexPage(opts: { title: string; heading: string; message: string; refreshSec?: number; ctaHref?: string; ctaLabel?: string; spinner?: boolean }): string {
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Cache-Control" content="no-store">
${opts.refreshSec ? `<meta http-equiv="refresh" content="${opts.refreshSec}">` : ""}
<title>${esc(opts.title)} · VortexGPU</title>
<style>
  :root { color-scheme: dark; }
  * { margin: 0; box-sizing: border-box; }
  body { min-height: 100vh; background: #05070d; color: #e4e4e7; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; }
  header { border-bottom: 1px solid rgba(39,39,42,.7); background: rgba(9,9,11,.6); backdrop-filter: blur(8px); }
  .bar { max-width: 72rem; margin: 0 auto; padding: .8rem 1.25rem; display: flex; align-items: center; gap: .5rem; font-weight: 900; letter-spacing: -.02em; color: #fff; font-size: 1.1rem; }
  .bar .cpu { color: #22d3ee; } .bar .accent { color: #22d3ee; }
  main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 2rem; background: radial-gradient(ellipse 60% 50% at 50% 0%, rgba(34,211,238,0.12), transparent 70%); }
  .card { max-width: 30rem; width: 100%; background: rgba(24,24,27,.5); border: 1px solid #27272a; border-radius: 1rem; padding: 2.5rem 2rem; text-align: center; }
  h1 { font-size: 1.5rem; font-weight: 800; letter-spacing: -.02em; color: #fff; }
  p { margin-top: .75rem; color: #a1a1aa; font-size: .9rem; line-height: 1.55; }
  .cta { display: inline-block; margin-top: 1.5rem; padding: .7rem 1.4rem; background: linear-gradient(to right, #06b6d4, #10b981); color: #000; font-weight: 800; border-radius: .75rem; text-decoration: none; font-size: .9rem; }
  .spinner { width: 44px; height: 44px; margin: 0 auto 1.25rem; border-radius: 9999px; border: 3px solid rgba(34,211,238,.2); border-top-color: #22d3ee; animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .note { margin-top: 1rem; font-size: .7rem; color: #52525b; }
</style>
</head>
<body>
<header><div class="bar"><svg class="cpu" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2M15 20v2M9 2v2M9 20v2M2 15h2M2 9h2M20 15h2M20 9h2"/></svg>VORTEX<span class="accent">GPU</span></div></header>
<main><div class="card">
${opts.spinner ? '<div class="spinner"></div>' : ""}
<h1>${esc(opts.heading)}</h1>
<p>${esc(opts.message)}</p>
${opts.ctaHref ? `<a class="cta" href="${esc(opts.ctaHref)}">${esc(opts.ctaLabel || "Back to console")}</a>` : ""}
${opts.refreshSec ? `<div class="note">Retrying automatically every ${opts.refreshSec}s&hellip;</div>` : ""}
</div></main>
</body>
</html>`;
  }

  function desktopStartingPage(instanceId: string): string {
    return vortexPage({
      title: "Desktop is starting",
      heading: "Desktop is starting…",
      message: `Your GPU desktop (${instanceId || "unknown"}) is still booting — noVNC isn't accepting connections yet. This page retries automatically and will hand off to your desktop the moment it's live.`,
      refreshSec: 4, spinner: true, ctaHref: "/", ctaLabel: "Back to console",
    });
  }

  function sessionEndedPage(instanceId: string): string {
    return vortexPage({
      title: "Session ended",
      heading: "Session ended — launch a new one",
      message: `Desktop ${instanceId || "unknown"} is stopped or no longer exists. Head back to the console to spawn a fresh Ubuntu GPU session.`,
      ctaHref: "/", ctaLabel: "Launch a new session",
    });
  }

  // Gate /session/<id>/ HTTP requests on DB state BEFORE proxying — a stopped,
  // unknown, or still-provisioning session gets a branded page, never a raw
  // ECONNREFUSED/504 from the proxy layer.
  app.use("/session/:instanceId", (req, res, next) => {
    const sess = one<any>("SELECT * FROM sessions WHERE instance_id=?", req.params.instanceId);
    res.setHeader("Cache-Control", "no-store");
    if (!sess) return res.status(404).type("html").send(sessionEndedPage(req.params.instanceId));
    if (sess.state === "provisioning") return res.status(503).type("html").send(desktopStartingPage(sess.instance_id));
    if (sess.state !== "running") return res.status(410).type("html").send(sessionEndedPage(sess.instance_id));
    next();
  });

  const sessionProxy = createProxyMiddleware({
    target: "http://127.0.0.1:1",
    changeOrigin: true,
    ws: true,
    pathFilter: "/session/**",
    router: (req) => {
      const m = (req.url || "").match(/^\/session\/([^/]+)/);
      if (!m) return "http://127.0.0.1:1";
      const sess = one<any>("SELECT * FROM sessions WHERE instance_id=?", m[1]);
      // The express state gate above does NOT run for WebSocket upgrades — those
      // are handed straight to sessionProxy.upgrade by the http server and never
      // traverse the express stack. Repeat the check here, otherwise a stopped,
      // failed or still-provisioning session's websockify stays reachable.
      return sess && sess.state === "running" ? `http://${sess.node_ip}:${sess.port}` : "http://127.0.0.1:1";
    },
    pathRewrite: (path) => path.replace(/^\/session\/[^/]+/, "") || "/",
    on: {
      // Belt-and-braces: a session row can say 'running' while the container is
      // still starting (or just died). HTTP → branded auto-retry page; WS → drop.
      error: (err, req, res) => {
        console.error(`[proxy] ${req.url}: ${(err as NodeJS.ErrnoException)?.code || err}`);
        // NOTE: req.url is already path-rewritten here ("/..."); originalUrl
        // still carries the /session/<id>/ prefix for the branded page.
        const rawUrl = (req as express.Request).originalUrl || req.url || "";
        const m = rawUrl.match(/^\/session\/([^/]+)/);
        const instanceId = m ? m[1] : "";
        if (res && typeof (res as http.ServerResponse).writeHead === "function") {
          const r = res as http.ServerResponse;
          if (!r.headersSent) {
            r.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
            r.end(desktopStartingPage(instanceId));
          }
        } else if (res && typeof (res as unknown as { destroy?: () => void }).destroy === "function") {
          (res as unknown as { destroy: () => void }).destroy();
        }
      },
    },
  });
  app.use(sessionProxy);

  // ===== STATIC =====
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath, {
      setHeaders: (res, filePath) => { if (filePath.endsWith("index.html")) res.setHeader("Cache-Control", "no-store"); },
    }));
    app.get("*", (req, res) => {
      if (req.path.startsWith("/admin") || req.path.startsWith("/api/admin")) return res.status(404).send("Not found");
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Kick the ProxyFly pool refresher (background auto-assign of clean proxies).
  refreshProxyPool();
  setInterval(refreshProxyPool, 5 * 60_000);

  // Keep vm rows honest against the host. A reconcile failure must never take
  // the gateway down, so errors are logged and swallowed.
  const runReconcile = () => reconcileVms().catch((e) => console.warn("[reconcile] pass failed:", e?.message));
  runReconcile();
  setInterval(runReconcile, VM_RECONCILE_MS);

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[VortexGPU] rent-a-PC gateway on :${PORT}`);
    console.log(`[VortexGPU] Proxmox ${PVE_HOST} | win tpl ${PVE_TEMPLATE_WIN} | linux tpl ${PVE_TEMPLATE_LINUX}`);
    console.log(`[VortexGPU] GPU SKU: ${GPU_SKU} | $${PRICE_USD_PER_HOUR}/hr | ${FREE_MACHINES} free machine(s)`);
  });
  server.on("upgrade", sessionProxy.upgrade);
}

startServer().catch((e) => { console.error(e); process.exit(1); });
