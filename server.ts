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

// ---- Proxmox ----
const PVE_HOST = process.env.PVE_HOST || "10.30.20.85";
const PVE_USER = process.env.PVE_USER || "root";
const PVE_TEMPLATE_WIN = Number(process.env.PVE_TEMPLATE_WIN) || 504;
const PVE_TEMPLATE_LINUX = Number(process.env.PVE_TEMPLATE_LINUX) || 990;
const PVE_VMID_START = Number(process.env.PVE_VMID_START) || 2000;

// ---- BTCPay ----
const BTCPAY_URL = process.env.BTCPAY_URL || "https://10.30.20.140";
const BTCPAY_API_KEY = process.env.BTCPAY_API_KEY || "";
const BTCPAY_STORE_ID = process.env.BTCPAY_STORE_ID || "";
const BTCPAY_PUBLIC = process.env.BTCPAY_PUBLIC || "https://btcpay.thetempleofdoom.com";
const WEBHOOK_SECRET = process.env.BTCPAY_WEBHOOK_SECRET || "";
if (!WEBHOOK_SECRET) throw new Error("BTCPAY_WEBHOOK_SECRET is required; refusing to start with an unsigned-webhook fallback");
const OWNER_SEED_PASSWORD = process.env.OWNER_SEED_PASSWORD || "";
const PRICE_USD_PER_HOUR = 1.0;
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

function num(v: unknown, fb: number): number { const n = Number(v); return Number.isFinite(n) ? n : fb; }
function str(v: unknown, fb: string): string { return typeof v === "string" && v.length ? v : fb; }
function normHost(v: unknown): string { return str(v, "").toLowerCase().trim(); }

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
async function vmStatus(vmid: number): Promise<string> {
  const r = await pve(["qm", "status", String(vmid)]);
  const m = r.out.match(/status:\s*(\w+)/);
  return m ? m[1] : "unknown";
}

// Allocate a unique public access port per VM (RDP 3389 / SSH 22 mapped to 30000+).
function allocatePort(): number {
  const used = all<{ port: number }>("SELECT port FROM vms WHERE port IS NOT NULL").map((r) => r.port);
  let p = 30000 + (Math.floor(Math.random() * 20000));
  while (used.includes(p)) p++;
  return p;
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
function allocateSessionPort(): number {
  const used = all<{ port: number }>("SELECT port FROM sessions WHERE port IS NOT NULL").map((r) => r.port);
  let p = 6090;
  while (used.includes(p) && p < 6190) p++;
  return p;
}

// Enqueue a GPU job for a node to pick up on its next poll.
function dispatchJob(hostname: string, kind: GpuJob["kind"], command: string, payload: Record<string, unknown>): GpuJob {
  const job: GpuJob = { id: "job_" + crypto.randomBytes(6).toString("hex"), hostname, kind, command, payload, status: "pending", result: "", createdAt: Date.now(), completedAt: null };
  jobs.push(job); persistJobs();
  return job;
}

// ---- auth helpers ----
function nodeAuthorized(req: express.Request) { return req.headers["x-node-secret"] === NODE_SECRET; }
function adminAuthorized(req: express.Request) { return (req.headers["authorization"] || "") === `Bearer ${ADMIN_TOKEN}`; }

// ---- User auth tokens (in-memory; issued on login/register) ----
const AUTH_TOKENS = new Map<string, string>(); // token -> userId
function issueToken(userId: string): string {
  const token = crypto.randomBytes(24).toString("hex");
  AUTH_TOKENS.set(token, userId);
  return token;
}
function tokenFromReq(req: express.Request): string {
  const auth = String(req.headers["authorization"] || "");
  return auth.startsWith("Bearer ") ? auth.slice(7) : String(req.headers["x-auth-token"] || "");
}
function userFromReq(req: express.Request): any | null {
  const token = tokenFromReq(req);
  const userId = token ? AUTH_TOKENS.get(token) : undefined;
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

function clientIp(req: express.Request): string {
  const fwd = req.headers["x-forwarded-for"];
  const raw = (Array.isArray(fwd) ? fwd[0] : fwd)?.toString().split(",")[0].trim() || req.socket.remoteAddress || "";
  return raw.replace(/^::ffff:/, "");
}

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
  app.use((req, res, next) => {
    if (req.method === "POST" && req.path === "/api/btcpay/webhook") return express.raw({ type: "application/json" })(req, res, next);
    express.json({ limit: "10mb" })(req, res, next);
  });

  // Dashboard/API responses are never cached (live state must always be fresh).
  app.use("/api", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

  // ===== PUBLIC =====
  app.get("/api/health", (_req, res) => {
    const online = Object.values(nodes).filter((n) => Date.now() - n.lastSeen < 30_000);
    res.json({
      status: "ok", node: "VortexGPU",
      gpuNodesOnline: online.length, gpuNodesTotal: Object.keys(nodes).length,
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

  app.post("/api/auth/register", (req, res) => {
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

  app.post("/api/auth/login", (req, res) => {
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

  // ===== VM PROVISIONING (real KVM clone) =====
  app.post("/api/vms/provision", async (req, res) => {
    const { os, app } = req.body || {};
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    const unlimited = !!user.unlimited;
    const active = countActive(user.id);
    if (!unlimited && active >= FREE_MACHINES && user.balance_minutes <= 0) return res.status(402).json({ error: "insufficient balance — your first machine is free; top up with Bitcoin for more" });
    if (!unlimited && active >= MAX_VMS_PER_USER) return res.status(429).json({ error: `limit reached — max ${MAX_VMS_PER_USER} machines per account` });

    const isWin = (os || "windows") === "windows";
    const template = isWin ? PVE_TEMPLATE_WIN : PVE_TEMPLATE_LINUX;
    const vmid = nextVmid() + Math.floor(Math.random() * 1000);
    const vmUid = "vm_" + crypto.randomBytes(6).toString("hex");
    const port = allocatePort(); // dedicated access port
    const name = isWin ? `vortex-win-${vmid}` : `vortex-lin-${vmid}`;
    const username = isWin ? "administrator" : "rent";
    const password = "Vx" + crypto.randomBytes(6).toString("hex") + "!";

    q("INSERT INTO vms (id,user_id,vm_id,node_hostname,name,os,sku,state,port,username,password,app,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      vmUid, user.id, vmid, PVE_HOST, name, isWin ? "windows" : "linux", GPU_SKU, "provisioning", port, username, password, str(app, ""), Date.now());

    // clone + start (long-running; runs in background)
    cloneVm(template, vmid, name).then(async (r) => {
      if (!r.ok) { q("UPDATE vms SET state='failed' WHERE id=?", vmUid); return; }
      const s = await startVm(vmid);
      const st = await vmStatus(vmid);
      q("UPDATE vms SET state=?, ip=? WHERE id=?", s.ok ? "running" : st, PVE_HOST, vmUid);
    });

    res.json({
      vmId: vmUid, os: isWin ? "windows" : "linux", sku: GPU_SKU, state: "provisioning",
      access: isWin ? { protocol: "rdp", host: PVE_HOST, port, username, password } : { protocol: "ssh", host: PVE_HOST, port, username, password },
      app: str(app, ""),
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

  // ===== BTCPAY =====
  app.post("/api/btcpay/create-invoice", async (req, res) => {
    const { usdAmount } = req.body || {};
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    const amountUsd = Math.max(1, Number(usdAmount) || 5);
    const minutes = Math.round(amountUsd / PRICE_USD_PER_HOUR * 60);
    if (!BTCPAY_API_KEY || !BTCPAY_STORE_ID) return res.status(500).json({ error: "BTCPay not configured" });

    const { status, data } = await btcpay("POST", `/api/v1/stores/${BTCPAY_STORE_ID}/invoices`, {
      amount: amountUsd.toFixed(2), currency: "USD", metadata: { userId: user.id, minutes },
    });
    if (status < 200 || status >= 300) return res.status(502).json({ error: data?.message || "BTCPay failed" });

    const invId = crypto.randomBytes(8).toString("hex");
    const checkoutLink = (data.checkoutLink || "").replace(BTCPAY_URL, BTCPAY_PUBLIC);
    q("INSERT INTO invoices (id,user_id,amount_usd,minutes,btcpay_invoice_id,checkout_link,status,created_at) VALUES (?,?,?,?,?,?,?,?)",
      invId, user.id, amountUsd, minutes, data.id, checkoutLink, "pending", Date.now());
    res.json({ invoiceId: invId, btcpayInvoiceId: data.id, amountUsd, minutesAdded: minutes, checkoutLink, status: "pending" });
  });

  app.post("/api/btcpay/webhook", (req, res) => {
    const sig = req.headers["btcpay-sig"] as string;
    if (!sig) return res.status(401).json({ error: "missing signature" });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
    const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
    if (sig !== `sha256=${expected}`) return res.status(401).json({ error: "bad signature" });
    let payload: any = {};
    try { payload = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : JSON.stringify(req.body)); } catch { return res.status(400).json({ error: "invalid json" }); }

    if (payload.type === "InvoiceSettled" || payload.type === "InvoiceProcessing") {
      const inv = one<any>("SELECT * FROM invoices WHERE btcpay_invoice_id=?", payload.invoiceId);
      if (inv && inv.status !== "settled") {
        q("UPDATE invoices SET status='settled', settled_at=? WHERE id=?", Date.now(), inv.id);
        q("UPDATE users SET balance_minutes = balance_minutes + ? WHERE id=?", inv.minutes, inv.user_id);
      }
    }
    res.json({ received: true });
  });

  // ===== UBUNTU GPU SESSIONS (spawn in-browser desktop with the 4080 attached) =====
  app.post("/api/session/spawn", (req, res) => {
    const { resolution } = req.body || {};
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    const unlimited = !!user.unlimited;
    const active = countActive(user.id);
    if (!unlimited && active >= FREE_MACHINES && user.balance_minutes <= 0) return res.status(402).json({ error: "insufficient balance — your first machine is free; top up with Bitcoin for more" });
    if (!unlimited && active >= MAX_VMS_PER_USER) return res.status(429).json({ error: `limit reached — max ${MAX_VMS_PER_USER} machines per account` });

    // Target the Linux GPU node (nightmare) that runs the Ubuntu-session agent.
    const hostname = "nightmare";
    const node = nodes[hostname];
    if (!node || Date.now() - node.lastSeen > 30_000) {
      return res.status(503).json({ error: "GPU node offline — try again shortly" });
    }

    const instanceId = "sess_" + crypto.randomBytes(4).toString("hex");
    const port = allocateSessionPort();
    const password = "Ub" + crypto.randomBytes(6).toString("hex") + "!";
    const reso = str(resolution, "1440x900");
    const id = "ses_" + crypto.randomBytes(8).toString("hex");
    const proxy = assignProxy(); // clean ProxyFly proxy, auto-assigned in background

    q("INSERT INTO sessions (id,user_id,instance_id,node_hostname,node_ip,port,password,resolution,proxy,state,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      id, user.id, instanceId, hostname, node.ip, port, password, reso, proxy?.proxy ?? null, "provisioning", Date.now());
    dispatchJob(hostname, "provision_ubuntu", "", { instanceId, port, password, resolution: reso, proxy: proxy?.proxy ?? null });

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

  // ===== GPU NODE LAYER =====
  app.post("/api/node/register", (req, res) => {
    if (!nodeAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
    const hostname = normHost(req.body?.hostname);
    if (!hostname) return res.status(400).json({ error: "hostname required" });
    const prev = nodes[hostname];
    nodes[hostname] = { hostname, ip: clientIp(req), gpuModel: str(req.body?.gpuModel, prev?.gpuModel ?? "GPU"), driverVersion: str(req.body?.driverVersion, prev?.driverVersion ?? ""), memTotalMb: num(req.body?.memTotalMb, prev?.memTotalMb ?? 0), memUsedMb: prev?.memUsedMb ?? 0, gpuUtilPct: prev?.gpuUtilPct ?? 0, tempC: prev?.tempC ?? 0, cpuUtilPct: prev?.cpuUtilPct ?? 0, ramTotalGb: num(req.body?.ramTotalGb, prev?.ramTotalGb ?? 0), ramUsedGb: prev?.ramUsedGb ?? 0, uptimeSec: prev?.uptimeSec ?? 0, lastSeen: Date.now() };
    persistNodes();
    res.json({ ok: true });
  });

  app.post("/api/node/report", (req, res) => {
    if (!nodeAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
    const b = req.body || {}; const hostname = normHost(b.hostname);
    if (!hostname) return res.status(400).json({ error: "hostname required" });
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
    job.result = String(req.body?.result ?? "");
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
    if (req.query.token !== ADMIN_TOKEN) return res.status(404).send("Not found");
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
      proxyPool: proxyPool.slice(0, 20).map((p) => ({ ip: p.ip, location: p.location, latencyMs: p.latencyMs })),
      adminToken: ADMIN_TOKEN,
    });
  });

  app.post("/api/admin/gpu/run", (req, res) => {
    if (!adminAuthorized(req)) return res.status(404).json({ error: "not found" });
    const { hostname, command } = req.body || {};
    if (!hostname || !command) return res.status(400).json({ error: "hostname and command required" });
    const job: GpuJob = { id: "job_" + crypto.randomBytes(6).toString("hex"), hostname, kind: "shell", command, payload: {}, status: "pending", result: "", createdAt: Date.now(), completedAt: null };
    jobs.push(job); persistJobs();
    res.json({ ok: true, jobId: job.id });
  });

  app.post("/api/admin/credit", (req, res) => {
    if (!adminAuthorized(req)) return res.status(404).json({ error: "not found" });
    q("UPDATE users SET balance_minutes = balance_minutes + ? WHERE id=?", num(req.body?.minutes, 0), str(req.body?.userId, ""));
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
      return sess ? `http://${sess.node_ip}:${sess.port}` : "http://127.0.0.1:1";
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

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[VortexGPU] rent-a-PC gateway on :${PORT}`);
    console.log(`[VortexGPU] Proxmox ${PVE_HOST} | win tpl ${PVE_TEMPLATE_WIN} | linux tpl ${PVE_TEMPLATE_LINUX}`);
    console.log(`[VortexGPU] GPU SKU: ${GPU_SKU} | $${PRICE_USD_PER_HOUR}/hr | ${FREE_MACHINES} free machine(s)`);
  });
  server.on("upgrade", sessionProxy.upgrade);
}

startServer().catch((e) => { console.error(e); process.exit(1); });
