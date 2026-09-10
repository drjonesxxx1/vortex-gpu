import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import https from "https";
import http from "http";
import net from "net";
import tls from "tls";
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
 * Proxies: operator-run VPN egress boxes (PROXY_ENDPOINTS), health-probed for
 *   an egress IP that is provably not the operator's own, and auto-assigned to
 *   each Ubuntu session on spawn. Fails CLOSED (see REQUIRE_CLEAN_PROXY).
 *   An opt-in tier 2 of untrusted public proxies (PROXY_FALLBACK_ENABLED) is
 *   used only when tier 1 has no clean exit, under the identical check.
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
// Legacy env. PVE_TEMPLATE_WIN was the single Windows template (historically
// VMID 504). It is now a deprecated alias: it still seeds the win11 tier's
// template when PVE_TEMPLATE_WIN11 is unset, so a running deploy that only set
// PVE_TEMPLATE_WIN keeps cloning the same guest for os=windows.
const PVE_TEMPLATE_WIN = Number(process.env.PVE_TEMPLATE_WIN) || 0;
const PVE_TEMPLATE_LINUX = Number(process.env.PVE_TEMPLATE_LINUX) || 990;
// New per-tier templates. win11 falls back to the legacy PVE_TEMPLATE_WIN if
// set, else 810. comando defaults to 504 (the old Windows template VMID). The
// LXC tier clones CT 991 with `pct`.
const PVE_TEMPLATE_WIN11 = Number(process.env.PVE_TEMPLATE_WIN11) || PVE_TEMPLATE_WIN || 810;
const PVE_TEMPLATE_COMANDO = Number(process.env.PVE_TEMPLATE_COMANDO) || 504;
const PVE_TEMPLATE_CT = Number(process.env.PVE_TEMPLATE_CT) || 991;
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
// The base billing unit. balance_minutes is denominated in "$1/hr-minutes":
// one balance_minute is one minute of a $1/hr machine (= $1/60). Top-ups convert
// USD -> balance_minutes at this base (see /api/btcpay/create-invoice), and a
// machine at $P/hr therefore burns P balance_minutes per minute of runtime. This
// stays 1.0 so the storefront's advertised price and the invoice conversion are
// unchanged; per-tier pricing is expressed as the multiplier P below.
const PRICE_USD_PER_HOUR = 1.0;

// ---- Tier catalog ----
// Every machine belongs to a tier. A tier fixes its marketing label, its price
// (USD/hr, overridable per-tier by env), and the mechanism that provisions it:
//   'qm'  -> Proxmox KVM guest via `qm clone <template>`
//   'pct' -> Proxmox LXC container via `pct clone <template>`
//   'gpu' -> Docker/noVNC GPU session on SESSION_NODE (/api/session/spawn)
// The price a tenant is quoted at provision time is LOCKED onto the machine row
// (price_usd_per_hour), so a later catalog/env change never re-prices a running
// machine. Prices are env-overridable; the defaults are the confirmed catalog.
type TierKind = "qm" | "pct" | "gpu";
interface Tier {
  key: string;
  label: string;
  priceUsdPerHour: number;
  kind: TierKind;
  template?: number;    // Proxmox VMID/CTID for qm/pct tiers
  os?: "windows" | "linux";
  protocol?: "rdp" | "ssh";
  username?: string;    // default tenant login for the guest
}
const CATALOG: Tier[] = [
  { key: "ubuntu-ct", label: "Ubuntu (headless CT)", priceUsdPerHour: num(process.env.PRICE_UBUNTU_CT, 1), kind: "pct", template: PVE_TEMPLATE_CT, os: "linux", protocol: "ssh", username: "rent" },
  { key: "linux-vm", label: "Ubuntu Linux VM", priceUsdPerHour: num(process.env.PRICE_LINUX_VM, 2), kind: "qm", template: PVE_TEMPLATE_LINUX, os: "linux", protocol: "ssh", username: "rent" },
  { key: "gpu", label: "GPU Session", priceUsdPerHour: num(process.env.PRICE_GPU, 5), kind: "gpu" },
  { key: "win11", label: "Windows 11", priceUsdPerHour: num(process.env.PRICE_WIN11, 10), kind: "qm", template: PVE_TEMPLATE_WIN11, os: "windows", protocol: "rdp", username: "administrator" },
  { key: "comando", label: "Comando VM", priceUsdPerHour: num(process.env.PRICE_COMANDO, 20), kind: "qm", template: PVE_TEMPLATE_COMANDO, os: "windows", protocol: "rdp", username: "administrator" },
];
const TIERS: Record<string, Tier> = Object.fromEntries(CATALOG.map((t) => [t.key, t]));
// Price for a stored machine row: the locked-in price wins; else the tier's
// current price; else the $1/hr base (a legacy row that predates these columns).
function rowPrice(row: any, fallbackTier: string): number {
  const p = Number(row?.price_usd_per_hour);
  if (Number.isFinite(p) && p > 0) return p;
  const t = TIERS[String(row?.tier ?? fallbackTier)];
  return t ? t.priceUsdPerHour : PRICE_USD_PER_HOUR;
}
// Kind for a stored vm row. A NULL tier is a legacy qm clone.
function rowKind(row: any): TierKind {
  return TIERS[String(row?.tier)]?.kind ?? "qm";
}

const MAX_INVOICE_CENTS = 1_000_000; // $10,000 ceiling on a single top-up
// A tenant session is advertised as a GPU machine. Handing one out on a node
// whose VRAM is already consumed by another workload gives them a desktop that
// cannot run anything on the GPU — while still billing them. Refuse instead.
// Set to 0 to disable the preflight.
const MIN_FREE_VRAM_MB = Number.isFinite(Number(process.env.MIN_FREE_VRAM_MB)) ? Number(process.env.MIN_FREE_VRAM_MB) : 2048;
// When a GPU spawn is blocked on VRAM, optionally ask the node's ollama to
// unload its resident models, then wait for the node's telemetry to confirm the
// VRAM actually returned before proceeding (same source of truth as the check,
// so we never proceed on assumption).
//
// DEFAULT OFF, and here is why: measured on this fleet, HyperSwap keeps a live
// connection to ollama and OLLAMA_KEEP_ALIVE=30m pins its ~14GB model, so it
// re-pins within seconds of any unload — the eviction is acknowledged
// (`done_reason: unload`) but the VRAM never comes back while HyperSwap runs.
// Turning this on there only disrupts the LLM for no gain. It IS effective when
// HyperSwap is stopped or its model footprint leaves >= MIN_FREE_VRAM_MB free.
// The real fix for coexistence is node-side (shrink the model's context/quant,
// lower OLLAMA_KEEP_ALIVE, or pause HyperSwap while a session is active) and is
// not something the gateway can reach.
const GPU_PREEMPT_OLLAMA = str(process.env.GPU_PREEMPT_OLLAMA, "0").trim() === "1";
// Where the session node's ollama listens. Empty = derive http://<node ip>:11434
// from the node's own telemetry at spawn time.
const OLLAMA_URL = str(process.env.OLLAMA_URL, "");
const GPU_PREEMPT_WAIT_MS = Math.max(2000, num(process.env.GPU_PREEMPT_WAIT_MS, 12000));
// The only node running the Linux docker/noVNC session agent. Health and spawn
// MUST agree on this, or health advertises capacity sessions cannot use.
const SESSION_NODE = process.env.SESSION_NODE || "nightmare";
const MAX_VMS_PER_USER = 3;
const FREE_MACHINES = Number(process.env.FREE_MACHINES) || 1; // 1st machine free, 2nd+ billed
// Billing tick. One tick charges each billable machine its tier's price (in
// balance_minutes), so the default of one minute keeps the "$P/hr" contract
// exact. TESTING ONLY: lower it to observe the sweep without waiting a minute —
// it does NOT change the per-tick charge, only how often the charge is applied,
// so anything other than 60000 in production bills faster than advertised.
const BILLING_TICK_MS = Math.max(1000, num(process.env.BILLING_TICK_MS, 60_000));

// Marketing tier label (what tenants see) — configurable, decoupled from truth.
const GPU_SKU = process.env.GPU_SKU || "NVIDIA GeForce RTX 4080 SUPER 16GB";

// ---- HyperSwap (live GPU arbitrator on the session node) ----
// HyperSwap arbitrates the shared RTX 4080 SUPER between the operator's own
// workloads (ollama, comfyui, stt-relay, desktop) and paying vortex sessions.
// The gateway integrates against its read-only HTTP API only; it NEVER manages
// HyperSwap and NEVER evicts an actively-running job. Base URL is derived from
// the session node's telemetry IP (http://<ip>:9090) unless HYPERSWAP_URL
// overrides it. Every field HyperSwap returns is treated as optional — if a
// number is missing we report it as null/unknown and never fabricate one.
const HYPERSWAP_URL = str(process.env.HYPERSWAP_URL, "");
const HYPERSWAP_PORT = num(process.env.HYPERSWAP_PORT, 9090);
// Short timeout so a slow/hung arbitrator never stalls a request path.
const HYPERSWAP_TIMEOUT_MS = Math.max(500, num(process.env.HYPERSWAP_TIMEOUT_MS, 2500));
// Cache the last derived reading briefly so repeated polls (health, spawn, the
// promoter, /api/sessions) don't hammer HyperSwap.
const HYPERSWAP_CACHE_MS = Math.max(0, num(process.env.HYPERSWAP_CACHE_MS, 2000));
// vortex's own priority in HyperSwap's scheme. Tenants numerically higher than
// this (stt-relay=70, desktop=90) outrank a session and must never be preempted.
const VORTEX_PRIORITY = num(process.env.VORTEX_PRIORITY, 65);
// MAY ask an IDLE reclaimable tenant (a parked ollama/comfy model with no
// running job) to yield the card for a session — reclaiming idle residency, not
// killing work. Never used against an active job. Default on.
const HYPERSWAP_RECLAIM_IDLE = str(process.env.HYPERSWAP_RECLAIM_IDLE, "1").trim() === "1";
// After a reclaim, wait up to this long for /api/gpu to confirm the VRAM came
// back before proceeding — same source of truth, so we never act on assumption.
const HYPERSWAP_RECLAIM_WAIT_MS = Math.max(0, num(process.env.HYPERSWAP_RECLAIM_WAIT_MS, 8000));

// ---- GPU session queue (wait-your-turn instead of a blunt 503) ----
// When the card is not available, a spawn is parked as a 'queued' session (no
// charge, no container) and a background promoter dispatches it oldest-first
// once the card frees. A queued session that is never granted expires to
// 'failed' after GPU_QUEUE_TTL_MS. MAX_GPU_SESSIONS bounds how many sessions may
// occupy the box at once (the operator's hard rule: never more than 5).
// Floors are low so the promoter can be exercised quickly under test; the
// PRODUCTION defaults (30min TTL, 5s sweep) are what run when unset.
const GPU_QUEUE_TTL_MS = Math.max(1000, num(process.env.GPU_QUEUE_TTL_MS, 30 * 60_000));
const MAX_GPU_SESSIONS = Math.max(1, num(process.env.MAX_GPU_SESSIONS, 5));
const GPU_QUEUE_SWEEP_MS = Math.max(250, num(process.env.GPU_QUEUE_SWEEP_MS, 5000));

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

// persistJobs() is a synchronous whole-file write on the single-threaded event
// loop, and it is called on every job-result POST *and* every node job poll. At
// MAX_JOBS(500) x the 64KB per-result cap that is a 32MB JSON.stringify plus a
// 32MB writeFileSync per poll — every node poll would stall the entire gateway.
// jobs.json is only ~20KB today, so this is latent, but a handful of large
// shell/hashcat results is all it takes.
//
// Two bounds, neither of which loses history the admin UI reads (it renders
// jobs.slice(-50)):
//   1. Only the most recent JOB_FULL_RESULT_KEEP jobs keep their full result.
//      Older ones are compacted in place — the job, its status, its timestamps
//      and the head of its output all survive; only the tail of a large body is
//      dropped, and the entry says so.
//   2. Writes are debounced, so a burst of polls and results costs one write.
const JOB_FULL_RESULT_KEEP = 50;
const JOB_ARCHIVED_RESULT_MAX = 2048;
const JOB_TRUNC_MARK = "\n… [result truncated]";
const JOB_PERSIST_DEBOUNCE_MS = 500;

function compactOldJobResults(): void {
  const cut = jobs.length - JOB_FULL_RESULT_KEEP;
  for (let i = 0; i < cut; i++) {
    const j = jobs[i];
    // endsWith() keeps this idempotent, so repeated passes cannot nibble a
    // result away a slice at a time.
    if (j.result.length > JOB_ARCHIVED_RESULT_MAX && !j.result.endsWith(JOB_TRUNC_MARK)) {
      j.result = j.result.slice(0, JOB_ARCHIVED_RESULT_MAX) + JOB_TRUNC_MARK;
    }
  }
}

let jobsDirty = false;
let jobsTimer: NodeJS.Timeout | null = null;
function flushJobs(): void {
  if (jobsTimer) { clearTimeout(jobsTimer); jobsTimer = null; }
  if (!jobsDirty) return;
  jobsDirty = false;
  compactOldJobResults();
  saveJson(JOBS_FILE, jobs);
}
function persistJobs(): void {
  jobsDirty = true;
  if (jobsTimer) return;
  jobsTimer = setTimeout(() => { jobsTimer = null; flushJobs(); }, JOB_PERSIST_DEBOUNCE_MS);
  // Never hold the process open just to write the job log.
  jobsTimer.unref?.();
}
// A debounce window is only safe if shutdown drains it: deploy.sh restarts the
// service, and losing the last write would leave a completed job recorded as
// still running. Both handlers exit explicitly so installing them cannot stop
// the service from terminating on a deploy.
process.on("exit", () => { try { flushJobs(); } catch { /* best effort */ } });
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => { try { flushJobs(); } catch { /* best effort */ } process.exit(0); });
}

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
    resolution TEXT, proxy TEXT,      -- clean egress proxy URL (auto-assigned)
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
// Per-tier pricing: the tier key and the price (USD/hr) LOCKED in at provision
// time. Nullable on purpose — a row that predates these columns bills at the
// $1/hr base via rowPrice()/rowKind() and never crashes the sweep.
ensureColumn("vms", "tier", "tier TEXT");
ensureColumn("vms", "price_usd_per_hour", "price_usd_per_hour REAL");
ensureColumn("sessions", "tier", "tier TEXT");
ensureColumn("sessions", "price_usd_per_hour", "price_usd_per_hour REAL");
// A GPU session may be parked in 'queued' state while it waits its turn on the
// shared card. status_reason records why a queued session was later failed
// (e.g. it timed out before the card ever freed). Nullable — legacy rows and
// non-queued rows leave it NULL.
ensureColumn("sessions", "status_reason", "status_reason TEXT");

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

// Usernames are case-insensitive. They were compared with a plain `=`, so
// `DrJones` could be registered alongside `drjones`: on a product where the
// username is the whole of a tenant's identity, that is a ready-made
// impersonation vector (and it made the free-machine-per-account limit easier
// to dress up as someone else).
//
// New rows are stored lowercase. Existing rows are deliberately NOT rewritten —
// a boot-time migration that collided two rows on the UNIQUE index would take
// the gateway down — so every lookup tries the literal value first and then a
// case-insensitive match. That leaves any pre-existing mixed-case account able
// to log in exactly as before, under either casing.
function normUsername(v: unknown): string { return str(v, "").toLowerCase(); }
function findUserByUsername(username: string): any | undefined {
  return one<any>("SELECT * FROM users WHERE username=?", username)
    ?? one<any>("SELECT * FROM users WHERE username=? COLLATE NOCASE", username);
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
// NO --skiplock. That flag deliberately bypasses the guest lock Proxmox holds
// during a clone/backup/migrate, so a destroy racing one of those could tear
// down a half-written guest and leave corrupt state behind. A locked guest must
// surface as a failed reclaim — which /api/vms/delete already turns into a 502
// that keeps the row for retry — not be forced through. --purge is kept: it is
// what removes the disks and the firewall/replication references, and is the
// whole point of the reclaim.
async function reclaimVm(vmid: number): Promise<{ ok: boolean; out: string }> {
  return pve(["qm", "destroy", String(vmid), "--purge"]);
}

// ---- LXC (pct) driver ----
// The ubuntu-ct tier is an LXC container, not a KVM guest. It mirrors the qm
// path's structure: clone in the background, set a per-tenant password, start,
// and reclaim with `pct destroy --purge` (same --skiplock reasoning as reclaimVm
// — a locked CT must surface as a failed reclaim, never be forced through).
async function cloneCt(template: number, ctid: number, name: string): Promise<{ ok: boolean; out: string }> {
  return pve(["pct", "clone", String(template), String(ctid), "--hostname", name, "--full"]);
}
async function startCt(ctid: number): Promise<{ ok: boolean; out: string }> {
  return pve(["pct", "start", String(ctid)]);
}
// Set the tenant's `rent` password inside the CT. `pct set --password` reads a
// tty, so drive chpasswd through `pct exec` instead (equivalent, and scriptable
// over SSH). The password charset (Vx<hex>!) is shell-safe inside single quotes.
async function setCtPassword(ctid: number, user: string, pw: string): Promise<{ ok: boolean; out: string }> {
  return pve(["pct", "exec", String(ctid), "--", "bash", "-c", `echo '${user}:${pw}' | chpasswd`]);
}
async function stopCt(ctid: number): Promise<{ ok: boolean; out: string }> {
  return pve(["pct", "shutdown", String(ctid)]);
}
async function ctStatus(ctid: number): Promise<string> {
  const r = await pve(["pct", "status", String(ctid)]);
  const m = r.out.match(/status:\s*(\w+)/);
  return m ? m[1] : "unknown";
}
async function reclaimCt(ctid: number): Promise<{ ok: boolean; out: string }> {
  return pve(["pct", "destroy", String(ctid), "--purge"]);
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
  // Every row is eligible, including 'provisioning' and 'stopping'. Those two
  // used to be excluded on the assumption that an in-process handler would
  // always move them on, but the only thing that does is cloneVm().then() /
  // the second write in /api/vms/destroy — both of which die with the process.
  // A deploy (or a crash) during a clone therefore stranded the row in
  // 'provisioning' forever: never billed, never cleaned, and permanently
  // holding one of the user's machine slots. The MIN_AGE cutoff below is what
  // protects a genuinely in-flight clone; past it, the row is abandoned by
  // definition and `qm list` is the truth. Still only ever UPDATEs `state`.
  const rows = all<any>("SELECT id, vm_id, state, created_at, tier FROM vms");
  let fixed = 0;
  for (const row of rows) {
    if (Number(row.created_at) > cutoff) continue;
    // `qm list` never enumerates LXC containers, so an ubuntu-ct row would be
    // read as "gone" and wrongly walked to 'failed'. Leave pct-kind rows alone;
    // their lifecycle is driven only by the provision/delete handlers.
    if (rowKind(row) === "pct") continue;
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
  // Same leak as the session pool, just with 20k ports instead of 101 -- far
  // less acute, identical cause. A terminal row does not hold a port.
  const used = new Set(all<{ port: number }>(`SELECT port FROM vms WHERE port IS NOT NULL AND state IN ${LIVE_STATES}`).map((r) => r.port));
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
  // Only LIVE sessions hold a port. Counting terminal rows too meant a stopped
  // or failed session reserved its port forever, and 101 such rows -- trivially
  // created -- permanently broke session spawning for every user on the
  // platform until someone hand-edited the database.
  const used = new Set(all<{ port: number }>(`SELECT port FROM sessions WHERE port IS NOT NULL AND state IN ${LIVE_STATES}`).map((r) => r.port));
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

// ---- Egress proxy pool (operator-run VPN boxes, health-probed, fail closed) ----
//
// This used to scrape a FREE PUBLIC proxy list and hand a random entry to each
// session. That was wrong three ways: the pool routinely probed down to zero
// (observed `0 clean / 677 fetched` for four consecutive refreshes, i.e. every
// session egressed from the operator's own WAN IP), anyone operating a free
// public proxy can read or tamper with tenant traffic, and an empty pool simply
// spawned the session unproxied — it failed OPEN. The scraped code path is gone
// entirely; there is no flag that can repopulate the pool from the internet.
//
// TIER 1 is exactly what PROXY_ENDPOINTS names: LAN boxes the operator runs,
// each with a VPN client plus a proxy listener, so traffic through the proxy
// egresses via the VPN. These are the trusted exits and are always preferred.
//
// TIER 2 is an OPT-IN (PROXY_FALLBACK_ENABLED=1, default off) pool sourced from
// the Proxifly free public list, for the case observed in production where all
// three operator boxes dropped their tunnels at once and every spawn was
// refused. It is a LAST RESORT and is honestly labelled as such: whoever runs a
// free public proxy can READ AND MODIFY every unencrypted byte a tenant sends
// through it, can see the destination of every TLS connection, and may be
// running it precisely to harvest that. Tier 2 is never handed out while a
// single Tier 1 exit is clean, it is surfaced per-endpoint in the admin state so
// the operator can see they are on untrusted exits, and a switch between tiers
// is logged. It buys availability by spending confidentiality — that trade is
// the operator's to make deliberately, which is why the default is 0.
//
// What tiering does NOT change is the safety bar. A Tier 2 endpoint is healthy
// under exactly the same rule as a Tier 1 one: a probe through it returned a
// syntactically valid IP that is not in PROXY_FORBIDDEN_EGRESS. There is no
// weaker path. If NOTHING in either tier verifies clean, the spawn is still
// refused — the fallback adds a tier, it does not add a way to fail open.
//
// THE HEALTH CHECK IS NOT A REACHABILITY CHECK. Observed in production: when a
// box's VPN dropped, its proxy kept accepting connections and happily served
// traffic from the operator's home IP. "Does it respond?" is worthless. An
// endpoint counts as healthy only when a probe fetched an egress-IP echo
// THROUGH it, got back a syntactically valid IP, and that IP is not in
// PROXY_FORBIDDEN_EGRESS. If PROXY_FORBIDDEN_EGRESS is empty the check cannot
// run at all, so nothing is ever healthy — fail closed, not "assume fine".
type ProxyEndpoint = {
  url: string;            // verbatim what the node agent is handed and dials
  protocol: string;       // http | https | socks5 | socks5h
  host: string;
  port: number;
  tier: 1 | 2;            // 1 = operator-run VPN box, 2 = untrusted public fallback
  healthy: boolean;       // reachable AND provably not leaking
  reachable: boolean;     // the probe completed, whatever it observed
  egressIp: string | null;
  latencyMs: number;
  lastChecked: number;    // epoch ms, 0 = never probed
  lastError: string | null;
};

const DEFAULT_PROXY_PORTS: Record<string, number> = { http: 3128, https: 3128, socks5: 1080, socks5h: 1080 };

/**
 * Turn a list of proxy URLs into endpoints. `quiet` suppresses the per-entry
 * rejection logs: a hand-written PROXY_ENDPOINTS typo is worth shouting about,
 * but a scraped list of hundreds routinely contains schemes we do not speak and
 * would otherwise flood the log every refresh.
 */
function parseProxyEndpoints(items: string[], tier: 1 | 2, quiet = false): ProxyEndpoint[] {
  const out: ProxyEndpoint[] = [];
  const seen = new Set<string>();
  const drop = (msg: string) => { if (!quiet) console.error(msg); };
  for (const item of items.map((s) => s.trim()).filter(Boolean)) {
    let u: URL;
    try { u = new URL(item); } catch { drop(`[proxy] ignoring unparseable endpoint: ${item}`); continue; }
    const protocol = u.protocol.replace(/:$/, "").toLowerCase();
    if (!(protocol in DEFAULT_PROXY_PORTS)) { drop(`[proxy] ignoring endpoint with unsupported scheme: ${item}`); continue; }
    const port = Number(u.port) || DEFAULT_PROXY_PORTS[protocol];
    if (!u.hostname) { drop(`[proxy] ignoring endpoint with no host: ${item}`); continue; }
    const url = `${protocol}://${u.hostname}:${port}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, protocol, host: u.hostname, port, tier, healthy: false, reachable: false, egressIp: null, latencyMs: 0, lastChecked: 0, lastError: null });
  }
  return out;
}

const proxyEndpoints: ProxyEndpoint[] = parseProxyEndpoints(str(process.env.PROXY_ENDPOINTS, "").split(","), 1);
// IPs that must NEVER be a session's egress — the operator's own WAN address.
const PROXY_FORBIDDEN_EGRESS = new Set(
  str(process.env.PROXY_FORBIDDEN_EGRESS, "").split(",").map((s) => s.trim()).filter(Boolean));
// Default 1: refuse to spawn a session that would have no clean egress.
const REQUIRE_CLEAN_PROXY = str(process.env.REQUIRE_CLEAN_PROXY, "1").trim() !== "0";
const PROXY_CHECK_URL = str(process.env.PROXY_CHECK_URL, "https://api.ipify.org");
// Short by design: a box whose VPN wedged must not stall the refresh loop.
const PROXY_CHECK_TIMEOUT_MS = Math.max(1000, num(process.env.PROXY_CHECK_TIMEOUT_MS, 6000));
const PROXY_REFRESH_MS = Math.max(15_000, num(process.env.PROXY_REFRESH_MS, 5 * 60_000));

// ---- Tier 2: opt-in Proxifly fallback ----
// Default OFF. Turning it on means accepting that some sessions will egress via
// a stranger's proxy that can read their unencrypted traffic (see the block
// comment above). It exists so a simultaneous outage of the operator's boxes
// degrades service instead of stopping it.
const PROXY_FALLBACK_ENABLED = str(process.env.PROXY_FALLBACK_ENABLED, "0").trim() === "1";
const PROXY_FALLBACK_SOURCE = str(process.env.PROXY_FALLBACK_SOURCE,
  "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/US/data.json");
// How many candidates we probe per refresh. The upstream list has run to 677
// entries; probing all of them at the check timeout would make the refresh far
// outlive its own interval, so it is capped and the cap is configurable.
const PROXY_FALLBACK_MAX = Math.max(0, num(process.env.PROXY_FALLBACK_MAX, 25));
// Probes run this many at a time, so a capped-but-large list still finishes in
// roughly (max/concurrency) * timeout rather than serialising.
const PROXY_PROBE_CONCURRENCY = 8;
// A hostile or broken source must not be able to exhaust memory: stop reading
// past this and treat the fetch as failed.
const PROXY_FALLBACK_MAX_BYTES = 4 * 1024 * 1024;

// Replaced wholesale ONLY on a successful refresh. A fetch failure leaves the
// previous (already-probed) pool in place rather than emptying it — an outage at
// jsdelivr is not evidence that these exits went bad.
let fallbackEndpoints: ProxyEndpoint[] = [];
let fallbackLastRefresh = 0;
let fallbackLastError: string | null = null;

let proxyRefreshing = false;
let proxyCursor = 0;
let fallbackCursor = 0;
// Which tier assignProxy() last served, so a switch can be logged exactly once.
let servingTier: 0 | 1 | 2 = 0;

function isIpLiteral(v: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(v) ? v.split(".").every((o) => Number(o) <= 255) : /^[0-9a-f:]+$/i.test(v) && v.includes(":");
}

/** SOCKS5 CONNECT (no auth). Resolves with a socket tunnelled to host:port. */
function socks5Tunnel(ep: ProxyEndpoint, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: ep.host, port: ep.port });
    let settled = false;
    const fail = (msg: string) => { if (settled) return; settled = true; sock.destroy(); reject(new Error(msg)); };
    sock.setTimeout(timeoutMs, () => fail("socks5 timeout"));
    sock.on("error", (e) => fail(`socks5 ${(e as NodeJS.ErrnoException).code || e.message}`));
    let stage: "greet" | "connect" = "greet";
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === "greet") {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail("socks5 refused (auth required or bad version)");
        buf = buf.subarray(2);
        stage = "connect";
        const hostBuf = Buffer.from(host, "utf8");
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]), hostBuf,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ]);
        sock.write(req);
        if (buf.length === 0) return;
      }
      // Reply: VER REP RSV ATYP ADDR PORT — length depends on ATYP.
      if (buf.length < 5) return;
      if (buf[1] !== 0x00) return fail(`socks5 connect rejected (rep=${buf[1]})`);
      const atyp = buf[3];
      const need = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : atyp === 0x03 ? 7 + buf[4] : -1;
      if (need < 0) return fail("socks5 bad ATYP");
      if (buf.length < need) return;
      if (settled) return;
      settled = true;
      sock.setTimeout(0);
      sock.removeAllListeners("data");
      sock.removeAllListeners("error");
      const extra = buf.subarray(need);
      if (extra.length) sock.unshift(extra);
      resolve(sock);
    });
    sock.on("connect", () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
  });
}

/** HTTP CONNECT tunnel through an http(s) proxy. */
function httpConnectTunnel(ep: ProxyEndpoint, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const mod = ep.protocol === "https" ? https : http;
    const req = mod.request({
      host: ep.host, port: ep.port, method: "CONNECT", path: `${host}:${port}`,
      headers: { Host: `${host}:${port}` }, timeout: timeoutMs,
      ...(ep.protocol === "https" ? { rejectUnauthorized: false } : {}),
    } as any);
    let settled = false;
    const fail = (msg: string) => { if (settled) return; settled = true; req.destroy(); reject(new Error(msg)); };
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return fail(`CONNECT returned ${res.statusCode}`); }
      settled = true;
      resolve(socket);
    });
    req.on("timeout", () => fail("CONNECT timeout"));
    req.on("error", (e) => fail(`CONNECT ${(e as NodeJS.ErrnoException).code || e.message}`));
    req.end();
  });
}

/**
 * GET `target` THROUGH `ep` and return the response body.
 *
 * An http(s) proxy fetching an http:// URL uses absolute-form (what Squid and
 * friends expect on 3128); everything else is tunnelled first — CONNECT for an
 * http(s) proxy, a SOCKS5 handshake for socks5 — and the request is then issued
 * over that socket, wrapped in TLS when the target is https://.
 */
function fetchThroughProxy(ep: ProxyEndpoint, target: URL, timeoutMs: number): Promise<string> {
  const targetPort = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
  const headers = { Host: target.host, "User-Agent": "VortexGPU/1.0", Connection: "close" };

  const collect = (req: http.ClientRequest, reject: (e: Error) => void, resolve: (s: string) => void) => {
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { if (body.length < 4096) body += c; });
      res.on("end", () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`probe HTTP ${res.statusCode}`))));
    });
    req.on("timeout", () => { req.destroy(new Error("probe timeout")); });
    req.on("error", (e) => reject(new Error((e as NodeJS.ErrnoException).code || e.message)));
    req.end();
  };

  if ((ep.protocol === "http" || ep.protocol === "https") && target.protocol === "http:") {
    return new Promise((resolve, reject) => {
      const mod = ep.protocol === "https" ? https : http;
      collect(mod.request({
        host: ep.host, port: ep.port, method: "GET", path: target.href, headers, timeout: timeoutMs,
        ...(ep.protocol === "https" ? { rejectUnauthorized: false } : {}),
      } as any), reject, resolve);
    });
  }

  const tunnel = ep.protocol === "socks5" || ep.protocol === "socks5h"
    ? socks5Tunnel(ep, target.hostname, targetPort, timeoutMs)
    : httpConnectTunnel(ep, target.hostname, targetPort, timeoutMs);

  return tunnel.then((socket) => new Promise<string>((resolve, reject) => {
    const path = `${target.pathname}${target.search}` || "/";
    const opts: any = {
      createConnection: () => (target.protocol === "https:"
        ? tls.connect({ socket, servername: target.hostname })
        : socket),
      host: target.hostname, port: targetPort, method: "GET", path, headers, timeout: timeoutMs,
    };
    const req = (target.protocol === "https:" ? https : http).request(opts);
    const done = (fn: (v: any) => void) => (v: any) => { try { socket.destroy(); } catch { /* already gone */ } fn(v); };
    collect(req, done(reject), done(resolve));
  }));
}

/**
 * Probe one endpoint and update its health in place. Healthy requires a real
 * answer AND a valid egress IP AND that IP not being a forbidden (leaking) one.
 */
async function probeProxyEndpoint(ep: ProxyEndpoint): Promise<void> {
  const wasHealthy = ep.healthy;
  const t0 = Date.now();
  let target: URL;
  try { target = new URL(PROXY_CHECK_URL); } catch {
    ep.healthy = false; ep.reachable = false; ep.lastError = "PROXY_CHECK_URL is not a URL"; ep.lastChecked = Date.now();
    return;
  }
  try {
    const body = await fetchThroughProxy(ep, target, PROXY_CHECK_TIMEOUT_MS);
    const egress = body.trim().split(/\s/)[0] || "";
    ep.latencyMs = Date.now() - t0;
    ep.lastChecked = Date.now();
    ep.reachable = true;
    if (!isIpLiteral(egress)) {
      ep.healthy = false; ep.egressIp = null;
      ep.lastError = `probe did not return an IP (${JSON.stringify(body.slice(0, 60))})`;
    } else {
      ep.egressIp = egress;
      if (PROXY_FORBIDDEN_EGRESS.size === 0) {
        // No forbidden list means the anonymity check cannot run. Refusing to
        // call anything healthy is the fail-closed answer; the alternative is
        // silently shipping tenants out of the operator's home IP again.
        ep.healthy = false;
        ep.lastError = "PROXY_FORBIDDEN_EGRESS is unset — cannot verify the exit is not the operator's own IP";
      } else if (PROXY_FORBIDDEN_EGRESS.has(egress)) {
        ep.healthy = false;
        ep.lastError = `LEAKING: egress ${egress} is a forbidden address`;
        console.error(ep.tier === 1
          ? `[proxy] LEAK ${ep.url}: egress is ${egress}, a forbidden address — the VPN on that box is DOWN and the proxy is serving the operator's own IP. Endpoint removed from the pool.`
          : `[proxy] LEAK ${ep.url} (fallback tier): egress is ${egress}, a forbidden address. Endpoint removed from the pool.`);
      } else {
        ep.healthy = true;
        ep.lastError = null;
      }
    }
  } catch (e) {
    ep.reachable = false;
    ep.healthy = false;
    ep.egressIp = null;
    ep.latencyMs = Date.now() - t0;
    ep.lastChecked = Date.now();
    ep.lastError = String((e as Error)?.message || e).slice(0, 200);
  }
  if (wasHealthy && !ep.healthy) console.error(`[proxy] ${ep.url} is no longer a clean exit: ${ep.lastError}`);
}

/** Probe `eps` at most `limit` at a time, so a long list cannot stall the loop. */
async function probeAll(eps: ProxyEndpoint[], limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= eps.length) return;
      await probeProxyEndpoint(eps[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), eps.length || 1) }, worker));
}

/** GET the fallback list itself — DIRECTLY, not through any proxy. */
function fetchFallbackSource(): Promise<string> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try { target = new URL(PROXY_FALLBACK_SOURCE); } catch { return reject(new Error("PROXY_FALLBACK_SOURCE is not a URL")); }
    if (target.protocol !== "http:" && target.protocol !== "https:") return reject(new Error(`unsupported source scheme ${target.protocol}`));
    let settled = false;
    const fail = (msg: string) => { if (settled) return; settled = true; try { req.destroy(); } catch { /* already gone */ } reject(new Error(msg)); };
    const req = (target.protocol === "https:" ? https : http).get(target, {
      headers: { "User-Agent": "VortexGPU/1.0", Connection: "close" }, timeout: PROXY_CHECK_TIMEOUT_MS,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return fail(`source returned HTTP ${res.statusCode}`); }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        if (settled) return;
        body += c;
        if (body.length > PROXY_FALLBACK_MAX_BYTES) fail(`source exceeded ${PROXY_FALLBACK_MAX_BYTES} bytes`);
      });
      res.on("end", () => { if (settled) return; settled = true; resolve(body); });
      res.on("error", (e) => fail(String((e as Error).message)));
    });
    req.on("timeout", () => fail("source fetch timeout"));
    req.on("error", (e) => fail(String((e as NodeJS.ErrnoException).code || (e as Error).message)));
  });
}

/**
 * Parse the Proxifly payload (a JSON array of {proxy|ip+port} objects) or a
 * plain newline list of `host:port` / `proto://host:port`. Throws when nothing
 * usable comes out, which the caller treats as a failed refresh — i.e. a 404
 * page or a truncated file leaves the previous pool alone instead of wiping it.
 */
function parseFallbackSource(body: string): ProxyEndpoint[] {
  const items: string[] = [];
  const trimmed = body.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let data: any;
    try { data = JSON.parse(trimmed); } catch { throw new Error("source did not parse as JSON"); }
    const arr: any[] | null = Array.isArray(data) ? data : Array.isArray(data?.proxies) ? data.proxies : null;
    if (!arr) throw new Error("source JSON was not a list of proxies");
    for (const p of arr) {
      if (typeof p === "string") items.push(p);
      else if (p?.proxy) items.push(String(p.proxy));
      else if (p?.ip && p?.port) items.push(`${String(p.protocol || "http")}://${p.ip}:${p.port}`);
    }
  } else {
    for (const line of trimmed.split(/[\r\n]+/)) {
      const s = line.trim();
      if (!s || s.startsWith("#")) continue;
      items.push(s.includes("://") ? s : `http://${s}`);
    }
  }
  const tier1 = new Set(proxyEndpoints.map((e) => e.url));
  const parsed = parseFallbackEndpointList(items).filter((e) => !tier1.has(e.url));
  if (!parsed.length) throw new Error("source contained no usable proxy entries");
  return parsed.slice(0, PROXY_FALLBACK_MAX);
}

function parseFallbackEndpointList(items: string[]): ProxyEndpoint[] {
  return parseProxyEndpoints(items, 2, true);
}

/**
 * Refresh Tier 2. Never throws: a failure is logged and the previous pool is
 * kept, because "the CDN 404'd" says nothing about the exits we already probed.
 */
async function refreshFallbackPool(): Promise<void> {
  if (!PROXY_FALLBACK_ENABLED) return;
  try {
    const candidates = parseFallbackSource(await fetchFallbackSource());
    // Probed BEFORE being published, and to the same bar as the operator's own
    // boxes: assignProxy() only ever sees entries that answered with an IP that
    // is not forbidden.
    await probeAll(candidates, PROXY_PROBE_CONCURRENCY);
    fallbackEndpoints = candidates;
    fallbackLastRefresh = Date.now();
    fallbackLastError = null;
    const clean = candidates.filter((e) => e.healthy).length;
    console.log(`[proxy] fallback tier (UNTRUSTED public proxies): ${clean} clean / ${candidates.length} probed, cap ${PROXY_FALLBACK_MAX}`);
  } catch (e) {
    fallbackLastError = String((e as Error)?.message || e).slice(0, 200);
    const kept = fallbackEndpoints.filter((e) => e.healthy).length;
    console.error(`[proxy] fallback refresh failed: ${fallbackLastError} — keeping the previous fallback pool (${kept} clean / ${fallbackEndpoints.length} known)`);
  }
}

async function refreshProxyPool() {
  if (proxyRefreshing) return;
  proxyRefreshing = true;
  try {
    // Tier 1 first and on its own: its health is what decides whether Tier 2 is
    // consulted at all, and it must not wait behind a slow public list.
    await probeAll(proxyEndpoints, PROXY_PROBE_CONCURRENCY);
    const healthy = proxyEndpoints.filter((e) => e.healthy).length;
    const msg = `[proxy] health: ${healthy} clean / ${proxyEndpoints.length} configured`;
    if (healthy === 0 && proxyEndpoints.length > 0) console.error(`${msg} — NO clean operator exit available`);
    else console.log(msg);
    await refreshFallbackPool();
  } catch (e) { console.error("[proxy]", e); }
  finally { proxyRefreshing = false; }
}

function healthyTier1(): ProxyEndpoint[] { return proxyEndpoints.filter((e) => e.healthy); }
function healthyTier2(): ProxyEndpoint[] { return PROXY_FALLBACK_ENABLED ? fallbackEndpoints.filter((e) => e.healthy) : []; }
/** Every verified-clean exit, both tiers. */
function healthyProxies(): ProxyEndpoint[] { return [...healthyTier1(), ...healthyTier2()]; }

// Ask the session node's ollama to unload every resident model, freeing VRAM
// for a paying GPU session. ollama reloads on its next request, so this preempts
// the operator's own LLM workload rather than killing it. Best-effort: any error
// is swallowed and the caller re-checks real telemetry to decide, so a failed
// eviction just means the spawn still 503s on capacity — never a false "clear".
async function evictOllamaModels(nodeIp: string): Promise<{ attempted: number }> {
  const base = OLLAMA_URL || `http://${nodeIp}:11434`;
  let attempted = 0;
  try {
    const ctl = AbortSignal.timeout(4000);
    const ps = await fetch(`${base}/api/ps`, { signal: ctl }).then((r) => r.json()).catch(() => null);
    const models: string[] = Array.isArray(ps?.models) ? ps.models.map((m: any) => m?.model || m?.name).filter(Boolean) : [];
    for (const model of models) {
      attempted++;
      // keep_alive:0 unloads the model as soon as this (empty) request returns.
      await fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, keep_alive: 0 }),
        signal: AbortSignal.timeout(6000),
      }).catch(() => {});
    }
    if (attempted) console.log(`[gpu] preempt: asked ollama at ${base} to unload ${attempted} model(s) for a GPU session`);
  } catch (e) {
    console.warn(`[gpu] preempt: could not reach ollama at ${base}: ${String((e as Error)?.message || e).slice(0, 120)}`);
  }
  return { attempted };
}

// Free VRAM (MiB) the node currently reports. Reads live telemetry, which the
// /api/node/report handler refreshes every few seconds.
function nodeFreeVramMb(n: any): number { return Math.max(0, (n?.memTotalMb || 0) - (n?.memUsedMb || 0)); }

// ============================================================================
// HyperSwap client + derived GPU status
// ----------------------------------------------------------------------------
// All of this is READ-ONLY against HyperSwap's HTTP API except the explicit
// idle-reclaim release, which is gated behind HYPERSWAP_RECLAIM_IDLE and only
// ever aimed at an IDLE reclaimable tenant. Nothing here throws into a request
// path: every failure degrades to source='unavailable'.
// ============================================================================

// Shape returned to callers. Numeric fields are `number | null` — null means
// "HyperSwap did not report it", never a fabricated value.
type GpuStatus = {
  source: "hyperswap" | "unavailable";
  busyPct: number | null;
  vramUsedGb: number | null;
  vramFreeGb: number | null;
  vramTotalGb: number | null;
  tempC: number | null;
  holder: string | null;
  activeJob: { model: string | null; elapsedS: number | null; etaS: number | null } | null;
  queueDepth: number;
  etaSeconds: number | null;
  available: boolean;
  // Internal hint for the spawn/promoter path: an idle reclaimable tenant that
  // is holding VRAM and could be asked to yield. Not part of the public shape.
  reclaimableIdleHolder?: string | null;
};

function unavailableStatus(): GpuStatus {
  return { source: "unavailable", busyPct: null, vramUsedGb: null, vramFreeGb: null, vramTotalGb: null, tempC: null, holder: null, activeJob: null, queueDepth: 0, etaSeconds: null, available: false, reclaimableIdleHolder: null };
}

// Base URL: explicit override, else derived from the session node's telemetry IP.
function hyperswapBase(): string | null {
  if (HYPERSWAP_URL) return HYPERSWAP_URL.replace(/\/+$/, "");
  const ip = nodes[SESSION_NODE]?.ip;
  return ip ? `http://${ip}:${HYPERSWAP_PORT}` : null;
}

// One GET against HyperSwap. Returns the parsed JSON, or null on any error
// (unreachable, timeout, non-2xx, bad JSON). Never throws.
async function hyperswapGet(base: string, apiPath: string): Promise<any | null> {
  try {
    const r = await fetch(`${base}${apiPath}`, { signal: AbortSignal.timeout(HYPERSWAP_TIMEOUT_MS) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// POST /api/tenants/{name}/release — asks a tenant to yield its VRAM. Only ever
// called for an IDLE reclaimable tenant (see resolveReclaimIdle). Best effort.
async function hyperswapRelease(base: string, tenant: string): Promise<boolean> {
  try {
    const r = await fetch(`${base}/api/tenants/${encodeURIComponent(tenant)}/release`, { method: "POST", signal: AbortSignal.timeout(HYPERSWAP_TIMEOUT_MS) });
    return r.ok;
  } catch { return false; }
}

// Parse a HyperSwap timestamp to epoch-ms. Accepts unix seconds, unix ms, or an
// ISO string. Returns NaN if unparseable (caller degrades to "unknown").
function parseHsTime(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v > 1e12) return v;        // already ms
    if (v > 1e9) return v * 1000;  // unix seconds
    return NaN;
  }
  if (typeof v === "string" && v) { const t = Date.parse(v); return Number.isFinite(t) ? t : NaN; }
  return NaN;
}

function median(nums: number[]): number | null {
  const xs = nums.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

// Median duration (seconds) of DONE jobs grouped by payload.model. Used for ETA.
function medianDurationForModel(jobsArr: any[], model: string | null): number | null {
  if (!model) return null;
  const durs = jobsArr
    .filter((j) => j && j.state === "done" && (j.payload?.model ?? null) === model && Number.isFinite(Number(j.duration_s)))
    .map((j) => Number(j.duration_s));
  return median(durs);
}

// A tenant is treated as ACTIVELY busy if HyperSwap flags a non-empty `busy`
// object for it. Missing/empty => not busy (degrade safe: we do not invent work).
function tenantBusy(t: any): boolean {
  const b = t?.busy;
  if (!b) return false;
  if (typeof b === "object") return Object.keys(b).length > 0;
  return !!b;
}

// Turn raw HyperSwap payloads into the derived status. `gpu` must be present for
// source='hyperswap'; tenants/stats/jobs are optional and degrade if missing.
function deriveGpuStatus(gpu: any, tenants: any, stats: any, jobsPayload: any): GpuStatus {
  const numOrNull = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) ? n : null; };

  const tenantList: any[] = Array.isArray(tenants?.tenants) ? tenants.tenants : [];
  const jobsArr: any[] = Array.isArray(jobsPayload?.jobs) ? jobsPayload.jobs : [];

  // Holder = tenant holding the most VRAM (>0), else null.
  let holder: string | null = null;
  let holderGb = 0;
  for (const t of tenantList) {
    const g = Number(t?.holding_gb);
    if (Number.isFinite(g) && g > holderGb) { holderGb = g; holder = str(t?.name, holder ?? "") || holder; }
  }

  // Running job on the card (earliest-started wins if HyperSwap reports several).
  const running = jobsArr.filter((j) => j && j.state === "running")
    .sort((a, b) => (parseHsTime(a.started_at) || 0) - (parseHsTime(b.started_at) || 0));
  const now = Date.now();
  let activeJob: GpuStatus["activeJob"] = null;
  if (running.length) {
    const j = running[0];
    const model = str(j.payload?.model, "") || null;
    const startMs = parseHsTime(j.started_at);
    const elapsedS = Number.isFinite(startMs) ? Math.max(0, Math.round((now - startMs) / 1000)) : null;
    const med = medianDurationForModel(jobsArr, model);
    const etaS = med !== null && elapsedS !== null ? Math.max(0, Math.round(med - elapsedS)) : null;
    activeJob = { model, elapsedS, etaS };
  }

  // Queue depth: queued+running jobs whose tenant is NOT vortex.
  const queueDepth = jobsArr.filter((j) => j && (j.state === "queued" || j.state === "running") && str(j.tenant, "") !== "vortex").length;

  // ---- Policy: wait your turn, do not evict active work ----
  const hasRunningJob = running.length > 0;
  const gpuBusyFlag = gpu?.available === false; // explicit "card not free" signal
  // A tenant that outranks vortex and is busy OR is holding the card blocks us.
  const higherPriorityBlock = tenantList.some((t) => num(t?.priority, 0) > VORTEX_PRIORITY && (tenantBusy(t) || Number(t?.holding_gb) > 0));

  // An IDLE reclaimable tenant currently holding the card (a parked model, no
  // running job of its own) — a candidate to reclaim to free the card.
  const busyTenants = new Set(jobsArr.filter((j) => j && j.state === "running").map((j) => str(j.tenant, "")));
  let reclaimableIdleHolder: string | null = null;
  for (const t of tenantList) {
    const name = str(t?.name, "");
    if (!name) continue;
    if (t?.reclaimable && Number(t?.holding_gb) > 0 && !busyTenants.has(name)) { reclaimableIdleHolder = name; break; }
  }

  const blocked = hasRunningJob || gpuBusyFlag || higherPriorityBlock;
  const available = !blocked;

  // etaSeconds: time until the card is free for a session.
  //  - available now            -> 0
  //  - a running job present     -> that job's etaS (may be null=unknown model)
  //  - higher-priority residency -> null (unknown, no job to time)
  let etaSeconds: number | null;
  if (available) etaSeconds = 0;
  else if (hasRunningJob && activeJob) etaSeconds = activeJob.etaS;
  else etaSeconds = null;

  return {
    source: "hyperswap",
    busyPct: numOrNull(gpu?.gpu_util_pct),
    vramUsedGb: numOrNull(gpu?.vram_used_gb),
    vramFreeGb: numOrNull(gpu?.vram_free_gb),
    vramTotalGb: numOrNull(gpu?.vram_total_gb),
    tempC: numOrNull(gpu?.temperature_c),
    holder,
    activeJob,
    queueDepth,
    etaSeconds,
    available,
    reclaimableIdleHolder,
  };
}

let gpuStatusCache: { at: number; value: GpuStatus } | null = null;
// Derived, cached GPU status. Never throws. `force` bypasses the cache (used to
// confirm VRAM after a reclaim).
async function getGpuStatus(force = false): Promise<GpuStatus> {
  const now = Date.now();
  if (!force && gpuStatusCache && now - gpuStatusCache.at < HYPERSWAP_CACHE_MS) return gpuStatusCache.value;
  const base = hyperswapBase();
  let value: GpuStatus;
  if (!base) {
    value = unavailableStatus();
  } else {
    // /api/gpu is the primary signal; if it is unreachable we report unavailable
    // (and fail safe to the VRAM floor). tenants/stats/jobs are optional.
    const [gpu, tenants, stats, jobsPayload] = await Promise.all([
      hyperswapGet(base, "/api/gpu"),
      hyperswapGet(base, "/api/tenants"),
      hyperswapGet(base, "/api/stats"),
      hyperswapGet(base, "/api/jobs"),
    ]);
    value = gpu ? deriveGpuStatus(gpu, tenants, stats, jobsPayload) : unavailableStatus();
  }
  gpuStatusCache = { at: now, value };
  return value;
}

// Only the fields safe to publish to unauthenticated visitors (landing-page busy
// meter): no IPs, no tenant internals beyond the holder NAME, busy% and ETA.
function publicGpuStatus(s: GpuStatus) {
  return { source: s.source, busyPct: s.busyPct, vramUsedGb: s.vramUsedGb, vramFreeGb: s.vramFreeGb, vramTotalGb: s.vramTotalGb, tempC: s.tempC, holder: s.holder, activeJob: s.activeJob, queueDepth: s.queueDepth, etaSeconds: s.etaSeconds, available: s.available };
}

// Sessions that occupy the box right now (a container is or is becoming live).
function liveGpuSessionCount(): number {
  const r = one<{ c: number }>(`SELECT COUNT(*) AS c FROM sessions WHERE state IN ('provisioning','running','stopping')`);
  return r?.c || 0;
}

// Ask an idle reclaimable tenant to yield, then wait (bounded) for /api/gpu to
// confirm the VRAM actually returned. Best effort; returns the final status.
async function reclaimIdleAndConfirm(holder: string): Promise<GpuStatus> {
  const base = hyperswapBase();
  if (!base) return getGpuStatus(true);
  console.log(`[gpu-queue] reclaiming idle reclaimable tenant '${holder}' to free the card for a session`);
  await hyperswapRelease(base, holder);
  const deadline = Date.now() + HYPERSWAP_RECLAIM_WAIT_MS;
  let st = await getGpuStatus(true);
  while (Date.now() < deadline && !st.available) {
    await new Promise((r) => setTimeout(r, 1000));
    st = await getGpuStatus(true);
  }
  return st;
}

// Turn an existing 'queued' (or freshly-created) session row into a live one:
// allocate a noVNC port and a clean proxy, flip it to 'provisioning' and
// dispatch the container. Shared by the immediate spawn path and the promoter.
// Returns { ok } on dispatch, or { ok:false, retry } when a resource is
// momentarily unavailable (no free port / no clean exit) so the caller can leave
// the row queued and try again on the next sweep. NEVER charges — billing starts
// only when the node reports the container running.
function activateQueuedSession(row: any): { ok: boolean; retry?: boolean; error?: string } {
  const port = allocateSessionPort();
  if (port === null) return { ok: false, retry: true, error: "no free session ports" };
  const proxy = assignProxy();
  if (!proxy && REQUIRE_CLEAN_PROXY) return { ok: false, retry: true, error: "no clean egress available" };
  const upd = q("UPDATE sessions SET port=?, proxy=?, state='provisioning' WHERE id=? AND state='queued'", port, proxy?.url ?? null, row.id);
  // If the row was not still 'queued' (raced by a destroy/delete), do not dispatch.
  if ((upd as any).changes === 0) return { ok: false, error: "session no longer queued" };
  dispatchJob(row.node_hostname, "provision_ubuntu", "", { instanceId: row.instance_id, port, password: row.password, resolution: row.resolution, proxy: proxy?.url ?? null });
  console.log(`[gpu-queue] promoted queued session ${row.id} -> provisioning on port ${port}`);
  return { ok: true };
}

// Background promoter. Same idiom as the billing/reconcile sweeps: expire stale
// queued rows, then, while the card is available and the box is under its
// concurrency cap, promote queued sessions oldest-first. Never throws.
async function promoteQueuedSessions(): Promise<void> {
  try {
    const queued = all<any>("SELECT * FROM sessions WHERE state='queued' ORDER BY created_at ASC");
    if (!queued.length) return;
    const now = Date.now();
    // 1. Expire queued rows older than the TTL to 'failed' with a reason.
    const live: any[] = [];
    for (const s of queued) {
      if (now - Number(s.created_at) > GPU_QUEUE_TTL_MS) {
        const reason = `queued ${Math.round((now - Number(s.created_at)) / 60000)}m without the GPU becoming available (TTL ${Math.round(GPU_QUEUE_TTL_MS / 60000)}m)`;
        q("UPDATE sessions SET state='failed', status_reason=? WHERE id=? AND state='queued'", reason, s.id);
        console.warn(`[gpu-queue] expired queued session ${s.id}: ${reason}`);
      } else {
        live.push(s);
      }
    }
    if (!live.length) return;
    // 2. Promote oldest-first while the card is available and we are under cap,
    //    re-checking availability before EACH promotion (the card may refill).
    for (const s of live) {
      if (liveGpuSessionCount() >= MAX_GPU_SESSIONS) break;
      let st = await getGpuStatus(true);
      if (st.source !== "hyperswap" || !st.available) {
        // Not free yet. If an idle reclaimable tenant is parked on it, reclaim.
        if (st.source === "hyperswap" && HYPERSWAP_RECLAIM_IDLE && st.reclaimableIdleHolder && !st.activeJob) {
          st = await reclaimIdleAndConfirm(st.reclaimableIdleHolder);
        }
        if (st.source !== "hyperswap" || !st.available) break; // still not free — wait
      } else if (st.reclaimableIdleHolder && HYPERSWAP_RECLAIM_IDLE) {
        // Available but an idle model is parked; reclaim so the container gets VRAM.
        await reclaimIdleAndConfirm(st.reclaimableIdleHolder);
      }
      const r = activateQueuedSession(s);
      if (!r.ok && r.retry) break; // out of ports/proxies — try again next sweep
    }
  } catch (e) { console.error("[gpu-queue]", e); }
}

// Attach live queue info (etaSeconds/queueDepth/holder) to any 'queued' rows in
// the array so /api/sessions and /api/me can render a countdown. One cached
// arbitrator read for the whole array; never throws (degrades to unknown).
async function attachQueueInfo(rows: any[]): Promise<void> {
  const st = await getGpuStatus();
  for (const r of rows) {
    if (r.state !== "queued") continue;
    r.etaSeconds = st.source === "hyperswap" ? st.etaSeconds : null;
    r.queueDepth = st.source === "hyperswap" ? st.queueDepth : null;
    r.holder = st.source === "hyperswap" ? st.holder : null;
  }
}
/** Everything we know about, for the admin view. */
function allProxyEndpoints(): ProxyEndpoint[] { return [...proxyEndpoints, ...(PROXY_FALLBACK_ENABLED ? fallbackEndpoints : [])]; }

/**
 * Round-robin over the HEALTHY endpoints only, TIER 1 FIRST. Tier 2 is reached
 * only when not one operator box is verified clean, so the trusted exits are
 * never given up while any of them works. Null when neither tier has a clean
 * exit — the caller fails the spawn closed.
 */
function assignProxy(): ProxyEndpoint | null {
  const t1 = healthyTier1();
  if (t1.length) {
    const pick = t1[proxyCursor % t1.length];
    proxyCursor = (proxyCursor + 1) % t1.length;
    noteServingTier(1);
    return pick;
  }
  const t2 = healthyTier2();
  if (!t2.length) { noteServingTier(0); return null; }
  const pick = t2[fallbackCursor % t2.length];
  fallbackCursor = (fallbackCursor + 1) % t2.length;
  noteServingTier(2);
  return pick;
}

function noteServingTier(tier: 0 | 1 | 2) {
  if (tier === servingTier) return;
  servingTier = tier;
  if (tier === 2) {
    console.error("[proxy] TIER SWITCH: no operator exit is clean — sessions are now being assigned UNTRUSTED public fallback proxies, which can read and modify tenant traffic. Restore the VPN boxes.");
  } else if (tier === 1) {
    console.log("[proxy] TIER SWITCH: back on operator-run exits (tier 1).");
  } else {
    console.error("[proxy] TIER SWITCH: no clean exit in either tier — spawns are being refused.");
  }
}

// Count a user's active machines (VMs + sessions) for the free-slot / cap.
// States in which a real host resource (a Proxmox guest, a GPU container) is
// alive and therefore occupies one of the user's machine slots. `stopping` MUST
// be included: `qm shutdown` can block for its full timeout, and until it
// returns the guest is still running. Excluding it let a user provision and
// immediately "destroy" in a loop -- each iteration freed the slot while the
// background clone kept going, bypassing MAX_VMS_PER_USER entirely and filling
// the hypervisor with unbilled guests.
const LIVE_STATES = "('provisioning','running','stopping')";

function countActive(userId: string): number {
  const v = one<{ c: number }>(`SELECT COUNT(*) as c FROM vms WHERE user_id=? AND state IN ${LIVE_STATES}`, userId);
  const s = one<{ c: number }>(`SELECT COUNT(*) as c FROM sessions WHERE user_id=? AND state IN ${LIVE_STATES}`, userId);
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
  // Body parsing runs BEFORE every per-route rateLimit(), so the parse cost is
  // paid by anonymous callers on unauthenticated routes and a 429 never refunds
  // it. A global 10mb limit therefore let anyone make the single-threaded event
  // loop chew through 10MB of JSON per request, as fast as they could send it.
  //
  // Nothing legitimate needs anything close to that. Every request body here is
  // a handful of short fields; the one exception is a node job result, which the
  // handler itself already caps at 64KB, so that path (and only that path) gets
  // a larger parser with headroom for JSON escaping. The webhook keeps
  // express.raw at its default 100kb — BTCPay invoice payloads are a few KB, and
  // the HMAC must cover the exact bytes, so it must not be parsed as JSON.
  const jsonSmall = express.json({ limit: "64kb" });
  const jsonJobResult = express.json({ limit: "1mb" });
  const rawWebhook = express.raw({ type: "application/json" });
  const JOB_RESULT_PATH_RE = /^\/api\/node\/jobs\/[^/]+\/result\/?$/;
  app.use((req, res, next) => {
    if (req.method === "POST" && req.path === "/api/btcpay/webhook") return rawWebhook(req, res, next);
    if (req.method === "POST" && JOB_RESULT_PATH_RE.test(req.path)) return jsonJobResult(req, res, next);
    jsonSmall(req, res, next);
  });

  // body-parser's own errors (over the limit, malformed JSON, bad charset) are
  // otherwise rendered as an HTML error page. Answer in the `{error:"..."}`
  // shape the rest of the API uses so a client can actually read them — and so
  // the stricter limit above reports itself clearly rather than as a mystery.
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!err || typeof err.type !== "string" || res.headersSent) return next(err);
    if (err.type === "entity.too.large") return res.status(413).json({ error: "request body too large" });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "invalid JSON body" });
    return res.status(400).json({ error: "bad request body" });
  });

  // Dashboard/API responses are never cached (live state must always be fresh).
  app.use("/api", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

  // ===== PUBLIC =====
  app.get("/api/health", async (_req, res) => {
    const now = Date.now();
    // Real GPU busy meter for the landing page (logged-out visitors). Only the
    // non-sensitive subset: no IPs, no tenant internals beyond the holder name,
    // busy% and ETA. Never throws (cached, degrades to source='unavailable').
    const gpuStatus = publicGpuStatus(await getGpuStatus());
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
      // Counts only — never an endpoint URL and never an egress IP. This route is
      // public, and the set of addresses a tenant can egress from is exactly the
      // thing an anonymity product must not publish.
      cleanExitsAvailable: healthyProxies().length,
      requireCleanProxy: REQUIRE_CLEAN_PROXY,
      gpuSku: GPU_SKU, priceUsdPerHour: PRICE_USD_PER_HOUR, maxVmsPerUser: MAX_VMS_PER_USER,
      freeMachines: FREE_MACHINES,
      // The five-tier catalog, so the storefront renders tiers and prices with
      // NO hardcoding (honesty rule: every user-facing price comes from here).
      // RESPONSE SHAPE ADDITION: new `catalog` array of {tier,label,priceUsdPerHour,kind}.
      catalog: CATALOG.map((t) => ({ tier: t.key, label: t.label, priceUsdPerHour: t.priceUsdPerHour, kind: t.kind })),
      // RESPONSE SHAPE ADDITION: real GPU arbitrator meter (safe subset). Also
      // hoist gpuBusyPct to the top level for a trivial landing-page read.
      gpuBusyPct: gpuStatus.busyPct,
      gpuStatus,
      timestamp: new Date().toISOString(),
    });
  });

  // Public GPU status straight from HyperSwap — REAL numbers only, no secrets.
  // Backs the landing-page busy meter and the session-queue countdown. Every
  // number is null when HyperSwap did not report it; source flips to
  // 'unavailable' (never a 500) if the arbitrator cannot be reached.
  app.get("/api/gpu-status", async (_req, res) => {
    res.json(publicGpuStatus(await getGpuStatus()));
  });

  // This published the exact egress proxy IPs handed to tenant sessions, to
  // anyone, unauthenticated. For a product sold on anonymity that is a
  // deanonymisation aid: the set of IPs a tenant's traffic can be leaving from
  // was a public list. Require an account AND drop the `ip` field — the pool
  // size, locations and latencies are the only parts a tenant has any use for,
  // and a tenant's own assigned proxy is already on their session row.
  // RESPONSE SHAPE CHANGE: `proxies[].ip` is gone, and the route now 401s when
  // unauthenticated. Nothing in src/ consumes this route; the admin surface
  // reads the pool from /api/admin/state.
  //
  // The pool is now the operator's own boxes, which makes leaking it WORSE, not
  // better: `ip` would be an egress the operator controls, and the endpoint URL
  // is a LAN address. Neither appears here — a tenant gets the healthy count and
  // per-entry latency only, and their own assigned proxy is on their session row.
  app.get("/api/proxy/pool", (req, res) => {
    if (!userFromReq(req)) return res.status(401).json({ error: "not authenticated" });
    // Deliberately tier-blind. Which tier is in play is operational detail for
    // the operator (see /api/admin/state); publishing "we are currently on public
    // fallback exits" to every logged-in tenant also publishes it to anyone who
    // can register, and that is a targeting signal, not a safety feature.
    const healthy = healthyProxies();
    res.json({
      count: healthy.length,
      configured: proxyEndpoints.length,
      requireCleanProxy: REQUIRE_CLEAN_PROXY,
      proxies: healthy.slice(0, 20).map((p) => ({ latencyMs: p.latencyMs, lastChecked: p.lastChecked })),
    });
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
    // Case-insensitive uniqueness, and stored lowercase. The charset check above
    // still runs against what was typed. NOTE: the account (and the `username`
    // echoed back in this response) is the lowercased form.
    const stored = normUsername(username);
    if (one<any>("SELECT id FROM users WHERE username=? COLLATE NOCASE", stored)) return res.status(409).json({ error: "username already taken" });

    const id = "usr_" + crypto.randomBytes(8).toString("hex");
    q("INSERT INTO users (id,username,balance_minutes,btc_address,created_at,password_hash,unlimited) VALUES (?,?,?,?,?,?,?)",
      id, stored, 0, "bc1q" + crypto.randomBytes(16).toString("hex"), Date.now(), hashPassword(password), 0);
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
    const user = findUserByUsername(username);
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

  app.get("/api/me", async (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    const vms = all<any>("SELECT * FROM vms WHERE user_id=? ORDER BY created_at DESC", user.id);
    const sessions = all<any>("SELECT * FROM sessions WHERE user_id=? ORDER BY created_at DESC", user.id);
    // Queued sessions carry etaSeconds/queueDepth/holder so the dashboard can
    // show a countdown (see /api/sessions). null when unknown, never faked.
    if (sessions.some((s) => s.state === "queued")) await attachQueueInfo(sessions);
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
  // Provisioning was entirely unrated. Each call starts a real clone (up to
  // 250GB) or a real container, so a loop here is a direct attack on the
  // hypervisor's disk and I/O regardless of the per-account slot cap. Keyed by
  // user id so it survives IP rotation.
  const provisionLimit = () => rateLimit("provision", 10, 60 * 60_000, (req) => resolveToken(tokenFromReq(req)) || clientIp(req));

  app.post("/api/vms/provision", provisionLimit(), async (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    // Tier resolution. Prefer an explicit `tier`; fall back to the legacy
    // os=windows|linux (windows -> win11, linux -> linux-vm) so existing callers
    // keep working. The GPU tier is provisioned only via /api/session/spawn.
    const tierKey = str(req.body?.tier, "");
    let tier: Tier | undefined;
    if (tierKey) {
      tier = TIERS[tierKey];
      if (!tier) return res.status(400).json({ error: `unknown tier — one of ${CATALOG.map((t) => t.key).join(", ")}` });
      if (tier.kind === "gpu") return res.status(400).json({ error: "the GPU tier is provisioned via /api/session/spawn" });
    } else {
      const osName = str(req.body?.os, "windows");
      if (osName !== "windows" && osName !== "linux") return res.status(400).json({ error: "os must be 'windows' or 'linux' (or pass an explicit tier)" });
      tier = osName === "windows" ? TIERS["win11"] : TIERS["linux-vm"];
    }
    // `app` is persisted and handed to node-side tooling; keep it to a safe charset.
    const appName = str(req.body?.app, "").slice(0, 64);
    if (appName && !/^[a-zA-Z0-9_. -]+$/.test(appName)) return res.status(400).json({ error: "invalid app" });
    const unlimited = !!user.unlimited;
    const active = countActive(user.id);
    if (!unlimited && active >= FREE_MACHINES && user.balance_minutes <= 0) return res.status(402).json({ error: "insufficient balance — your first machine is free; top up with Bitcoin for more" });
    if (!unlimited && active >= MAX_VMS_PER_USER) return res.status(429).json({ error: `limit reached — max ${MAX_VMS_PER_USER} machines per account` });
    const freeDenied = freeMachineDenial(req, user);
    if (freeDenied) return res.status(402).json({ error: freeDenied });

    const isPct = tier.kind === "pct";
    const template = tier.template as number;
    const vmid = nextVmid() + Math.floor(Math.random() * 1000);
    const vmUid = "vm_" + crypto.randomBytes(6).toString("hex");
    const port = allocatePort(); // dedicated access port
    if (port === null) return res.status(503).json({ error: "no free ports — try again shortly" });
    const shortName = isPct ? "ct" : tier.os === "windows" ? "win" : "lin";
    const name = `vortex-${shortName}-${vmid}`;
    const username = tier.username as string;
    const protocol = tier.protocol as "rdp" | "ssh";
    const password = "Vx" + crypto.randomBytes(6).toString("hex") + "!";

    // The tier and the price quoted RIGHT NOW are locked onto the row; a later
    // catalog/env change never re-prices this machine. `os` keeps its historical
    // meaning; `sku` becomes the tier's marketing label.
    q("INSERT INTO vms (id,user_id,vm_id,node_hostname,name,os,sku,state,port,username,password,app,created_at,tier,price_usd_per_hour) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      vmUid, user.id, vmid, PVE_HOST, name, tier.os as string, tier.label, "provisioning", port, username, password, appName, Date.now(), tier.key, tier.priceUsdPerHour);

    // clone + start (long-running; runs in background). Route on the tier's
    // mechanism: LXC via pct, KVM via qm.
    if (isPct) {
      cloneCt(template, vmid, name).then(async (r) => {
        if (!r.ok) { q("UPDATE vms SET state='failed' WHERE id=?", vmUid); return; }
        await setCtPassword(vmid, username, password);
        const s = await startCt(vmid);
        q("UPDATE vms SET state=?, ip=? WHERE id=?", s.ok ? "running" : "failed", PVE_HOST, vmUid);
      });
    } else {
      cloneVm(template, vmid, name).then(async (r) => {
        if (!r.ok) { q("UPDATE vms SET state='failed' WHERE id=?", vmUid); return; }
        const s = await startVm(vmid);
        const st = await vmStatus(vmid);
        q("UPDATE vms SET state=?, ip=? WHERE id=?", s.ok ? "running" : st, PVE_HOST, vmUid);
      });
    }

    recordFreeMachine(req, user);
    res.json({
      // RESPONSE SHAPE ADDITION: `tier` and `priceUsdPerHour` now accompany the
      // existing fields. `os` and `sku` are unchanged in type.
      vmId: vmUid, tier: tier.key, priceUsdPerHour: tier.priceUsdPerHour,
      os: tier.os, sku: tier.label, state: "provisioning",
      access: { protocol, host: PVE_HOST, port, username, password },
      app: appName,
    });
  });

  app.post("/api/vms/destroy", async (req, res) => {
    const { vmId } = req.body || {};
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    const vm = one<any>("SELECT * FROM vms WHERE id=? AND user_id=?", str(vmId, ""), user.id);
    if (!vm) return res.status(404).json({ error: "not found" });
    // A clone in flight cannot be stopped safely: `qm shutdown` races the clone,
    // and walking the row to `stopped` would let it be deleted while the
    // background clone is still writing. (The reclaim no longer passes
    // --skiplock, so such a destroy now fails on the guest lock rather than
    // forcing through — but the row would still be walked into a state it has
    // no business being in, so refuse here as well.)
    if (vm.state === "provisioning") return res.status(409).json({ error: "still provisioning — wait for it to finish before stopping" });
    if (vm.state === "stopping") return res.status(409).json({ error: "already stopping" });
    if (vm.state === "stopped" || vm.state === "failed") return res.json({ ok: true });
    q("UPDATE vms SET state='stopping' WHERE id=?", vm.id);
    // pve() resolves {ok:false} rather than rejecting, so an ignored result here
    // recorded a guest as stopped while it was still running -- unbilled,
    // uncounted, and still consuming the host. Escalate, then verify.
    // Route the shutdown on the row's kind: pct for an LXC container, qm for a
    // KVM guest. Both escalate from a graceful shutdown to a hard stop, then
    // verify with the matching status command.
    const isPct = rowKind(vm) === "pct";
    let r = isPct ? await stopCt(vm.vm_id) : await stopVm(vm.vm_id);
    if (!r.ok) r = await pve([isPct ? "pct" : "qm", "stop", String(vm.vm_id)]);
    const st = isPct ? await ctStatus(vm.vm_id) : await vmStatus(vm.vm_id);
    if (st === "running") {
      console.error(`[vms] ${vm.id} (vmid ${vm.vm_id}) would not stop; leaving in 'stopping' so it stays billed and counted`);
      return res.status(502).json({ error: "the machine did not stop — it is still running and still billed; try again shortly" });
    }
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
    // Dispatch the reclaim on the row's kind: an LXC container must be torn down
    // with `pct destroy`, a KVM guest with `qm destroy`. A NULL-tier legacy row
    // is a qm clone (rowKind default).
    const rec = rowKind(vm) === "pct" ? await reclaimCt(vm.vm_id) : await reclaimVm(vm.vm_id);
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
  app.post("/api/session/spawn", provisionLimit(), async (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    // `resolution` is forwarded verbatim in the provision_ubuntu job payload and
    // consumed by the node agent when it starts Xvfb/noVNC. Anything other than
    // WxH must never reach that side.
    const reso = str(req.body?.resolution, "1440x900");
    if (!/^\d{3,5}x\d{3,5}$/.test(reso)) return res.status(400).json({ error: "resolution must look like 1440x900" });
    const unlimited = !!user.unlimited;
    // A queued session has committed a machine slot even though nothing is
    // running yet, so count queued rows alongside live ones — otherwise a user
    // could stack unbounded queued rows past their per-account limit.
    const queuedForUser = one<{ c: number }>("SELECT COUNT(*) AS c FROM sessions WHERE user_id=? AND state='queued'", user.id)?.c || 0;
    const active = countActive(user.id) + queuedForUser;
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

    // The /session/<instanceId>/ proxy is necessarily unauthenticated (noVNC
    // loads it as a top-level iframe navigation with no Authorization header),
    // so the instance id IS the capability. 4 bytes was guessable; use 16.
    const instanceId = "sess_" + crypto.randomBytes(16).toString("hex");
    const password = "Ub" + crypto.randomBytes(6).toString("hex") + "!";
    const id = "ses_" + crypto.randomBytes(8).toString("hex");
    // Every session is the GPU tier; lock its tier and price onto the row so the
    // sweep bills it at the GPU rate (not the flat $1/hr it used to assume).
    const gpuTier = TIERS["gpu"];

    // Dispatch a live session RIGHT NOW (port + clean proxy + provision job) and
    // respond 200. Used when the card is available (arbitrator) or when the VRAM
    // floor passed (arbitrator unavailable). Nothing above this point charged.
    const spawnNow = () => {
      const port = allocateSessionPort();
      if (port === null) return res.status(503).json({ error: "no free ports — try again shortly" });
      // Clean-egress preflight. This product is sold on anonymity, so a session
      // with no verified-clean proxy would egress from the operator's own WAN IP
      // and deanonymise the tenant. Fails CLOSED: 503, no row, nothing charged.
      const proxy = assignProxy(); // round-robin over provably-clean exits only
      if (!proxy && REQUIRE_CLEAN_PROXY) {
        const fb = PROXY_FALLBACK_ENABLED ? `, 0 of ${fallbackEndpoints.length} fallback exits` : "";
        return res.status(503).json({ error: `no clean egress available — 0 of ${proxyEndpoints.length} configured proxies${fb} are verified clean, and this platform will not start an unproxied session. Nothing was charged; try again shortly.` });
      }
      q("INSERT INTO sessions (id,user_id,instance_id,node_hostname,node_ip,port,password,resolution,proxy,state,created_at,tier,price_usd_per_hour) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id, user.id, instanceId, hostname, node.ip, port, password, reso, proxy?.url ?? null, "provisioning", Date.now(), gpuTier.key, gpuTier.priceUsdPerHour);
      dispatchJob(hostname, "provision_ubuntu", "", { instanceId, port, password, resolution: reso, proxy: proxy?.url ?? null });
      recordFreeMachine(req, user);
      return res.json({ id, instanceId, port, password, resolution: reso, proxy: proxy?.url ?? null, state: "provisioning", url: `/session/${instanceId}/`, desktopUrl: desktopUrlFor(instanceId, password) });
    };

    // ---- Arbitrator-driven admission (HyperSwap) ----
    // Replace the blunt VRAM 503 with "wait your turn": ask HyperSwap whether the
    // card is available under the wait-patiently policy. When it is, spawn now
    // (optionally reclaiming an IDLE reclaimable tenant first, then confirming via
    // /api/gpu). When it is not — or we are at the box's concurrency cap — park a
    // 'queued' session (no charge, no container) and let the promoter dispatch it
    // when the card frees. When HyperSwap is unavailable we FAIL SAFE to the
    // MIN_FREE_VRAM_MB floor so an outage still refuses a card it cannot confirm.
    const status = await getGpuStatus();
    if (status.source === "hyperswap") {
      const underCap = liveGpuSessionCount() < MAX_GPU_SESSIONS;
      let st = status;
      // Card free but an idle model is parked — reclaim it (idle residency, not
      // active work) and re-confirm the VRAM actually returned before committing.
      if (st.available && underCap && HYPERSWAP_RECLAIM_IDLE && st.reclaimableIdleHolder && !st.activeJob) {
        st = await reclaimIdleAndConfirm(st.reclaimableIdleHolder);
      }
      if (st.available && underCap) return spawnNow();
      // Not available (or over cap): queue it. DO NOT charge, DO NOT dispatch.
      // port=0 / proxy=null are placeholders the promoter fills at promotion.
      q("INSERT INTO sessions (id,user_id,instance_id,node_hostname,node_ip,port,password,resolution,proxy,state,created_at,tier,price_usd_per_hour) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id, user.id, instanceId, hostname, node.ip, 0, password, reso, null, "queued", Date.now(), gpuTier.key, gpuTier.priceUsdPerHour);
      recordFreeMachine(req, user);
      console.log(`[gpu-queue] queued session ${id} for ${user.username} (holder=${st.holder ?? "none"} etaSeconds=${st.etaSeconds ?? "unknown"} underCap=${underCap})`);
      return res.status(202).json({ id, instanceId, state: "queued", etaSeconds: st.etaSeconds, queueDepth: st.queueDepth, holder: st.holder, url: `/session/${instanceId}/` });
    }

    // ---- Fallback: HyperSwap unavailable — the MIN_FREE_VRAM_MB floor ----
    // Capacity preflight against real nvidia-smi telemetry from the node.
    let freeVramMb = nodeFreeVramMb(node);
    if (MIN_FREE_VRAM_MB > 0 && node.memTotalMb > 0 && freeVramMb < MIN_FREE_VRAM_MB) {
      // Try to preempt the operator's own ollama workload rather than refusing.
      // Evict, then WAIT for the node's telemetry to actually reflect the freed
      // VRAM — same source of truth as the check above, so we never proceed on a
      // hopeful assumption. If it does not come back, fall through to the 503.
      if (GPU_PREEMPT_OLLAMA && node.ip) {
        const { attempted } = await evictOllamaModels(node.ip);
        // Only wait on telemetry if we actually unloaded something; otherwise
        // nothing will change and polling would just stall the request (and the
        // tests) for no reason — the VRAM is held by something we cannot move.
        if (attempted > 0) {
          const deadline = Date.now() + GPU_PREEMPT_WAIT_MS;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 1500));
            freeVramMb = nodeFreeVramMb(nodes[hostname]); // re-read: the report handler mutates this in the background
            if (freeVramMb >= MIN_FREE_VRAM_MB) break;
          }
          if (freeVramMb >= MIN_FREE_VRAM_MB) console.log(`[gpu] preempt succeeded — ${freeVramMb} MiB free after eviction`);
        }
      }
      if (freeVramMb < MIN_FREE_VRAM_MB) {
        return res.status(503).json({ error: `GPU at capacity — ${freeVramMb} MiB VRAM free, ${MIN_FREE_VRAM_MB} MiB required. Nothing was charged; try again shortly.` });
      }
    }
    return spawnNow();
  });

  app.get("/api/sessions", async (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    const rows = all<any>("SELECT * FROM sessions WHERE user_id=? ORDER BY created_at DESC", user.id);
    // RESPONSE SHAPE ADDITION: rows with state='queued' carry etaSeconds,
    // queueDepth and holder (live from the arbitrator) so the UI can show a
    // countdown. Still a bare array — see CLAUDE.md gotcha — every other row is
    // unchanged. etaSeconds is null when unknown, never a fabricated number.
    if (rows.some((r) => r.state === "queued")) await attachQueueInfo(rows);
    res.json(rows);
  });

  app.post("/api/session/destroy", (req, res) => {
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ error: "not authenticated" });
    const sess = one<any>("SELECT * FROM sessions WHERE id=? AND user_id=?", str(req.body?.sessionId, ""), user.id);
    if (!sess) return res.status(404).json({ error: "not found" });
    // Same reasoning as /api/vms/destroy: a container still being provisioned
    // must not be walked to a terminal state, or the late provision result
    // races the destroy and the row ends up describing a container that is
    // gone (or missing one that is running).
    if (sess.state === "provisioning") return res.status(409).json({ error: "still provisioning — wait for it to finish before stopping" });
    if (sess.state === "stopped" || sess.state === "failed") return res.json({ ok: true });
    // A queued session never had a container dispatched, so there is nothing to
    // destroy on the node and it must not enter 'stopping' (which the billing
    // sweep would treat as live). Cancel it straight to 'stopped'.
    if (sess.state === "queued") { q("UPDATE sessions SET state='stopped', status_reason='cancelled while queued' WHERE id=? AND state='queued'", sess.id); return res.json({ ok: true }); }
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
    // Reclaim BEFORE dropping the row, mirroring /api/vms/delete. The row is the
    // only handle on the container: a 'failed' session is exactly the case where
    // the node may have half-created or fully created one, and deleting the row
    // left it running unbilled on the GPU box, holding VRAM that the
    // MIN_FREE_VRAM_MB preflight then refuses other customers on.
    // Unlike the VM path this cannot be confirmed synchronously — the node layer
    // is a job queue, not an RPC — so the job is enqueued (durably, in jobs.json)
    // and the row goes. destroy_ubuntu on an instance that is already gone is a
    // no-op on the node, so re-issuing it for a 'stopped' row is harmless.
    dispatchJob(sess.node_hostname, "destroy_ubuntu", "", { instanceId: sess.instance_id });
    q("DELETE FROM sessions WHERE id=? AND user_id=? AND state IN ('stopped','failed')", sess.id, user.id);
    console.log(`[sessions] dispatched destroy_ubuntu for ${sess.instance_id} and removed row ${sess.id}`);
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
    // Reflect the job result onto the session row, but ONLY if the row is still
    // in the state this job was dispatched from. Job results arrive out of
    // order: destroying a session while it is still provisioning made the
    // destroy write 'stopped' and the older provision_ubuntu result then write
    // 'running' over it, leaving the row billed for a container that no longer
    // exists (and the reverse ordering recorded a live container as stopped).
    // The state predicate makes each update a no-op once the row has moved on.
    const p = job.payload as any;
    if (job.kind === "provision_ubuntu" && p?.instanceId) {
      q("UPDATE sessions SET state=? WHERE instance_id=? AND state='provisioning'", req.body?.ok ? "running" : "failed", p.instanceId);
    } else if (job.kind === "destroy_ubuntu" && p?.instanceId) {
      q("UPDATE sessions SET state='stopped' WHERE instance_id=? AND state='stopping'", p.instanceId);
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
      // Admin-gated, so this is the one place the endpoint URLs and observed
      // egress IPs are allowed to appear — that is precisely the operator's
      // signal that a box's VPN has dropped. `ip`/`location` stay populated so
      // the existing admin panel keeps rendering; `ip` falls back to the URL when
      // no egress was observed, so rows stay distinct.
      //
      // `tier` and `tierLabel` are the honest answer to "whose exit is my tenant
      // actually leaving through right now?". Tier 2 is a stranger's proxy that
      // can read and modify their traffic; the operator must be able to SEE that
      // they are running on those rather than infer it. Admin-gated only.
      proxyPool: allProxyEndpoints().slice(0, 40).map((p) => ({
        url: p.url,
        tier: p.tier,
        tierLabel: p.tier === 1 ? "operator-vpn" : "public-fallback-UNTRUSTED",
        healthy: p.healthy,
        reachable: p.reachable,
        egressIp: p.egressIp,
        lastChecked: p.lastChecked,
        lastError: p.lastError,
        ip: p.egressIp ?? p.url,
        location: p.healthy ? (p.tier === 1 ? "clean" : "clean (untrusted fallback)") : p.egressIp ? "LEAKING" : "down",
        latencyMs: p.latencyMs,
      })),
      requireCleanProxy: REQUIRE_CLEAN_PROXY,
      egress: {
        cleanTier1: healthyTier1().length,
        cleanTier2: healthyTier2().length,
        // True when the next spawn WOULD be handed an untrusted public proxy.
        servingUntrustedFallback: healthyTier1().length === 0 && healthyTier2().length > 0,
        fallbackEnabled: PROXY_FALLBACK_ENABLED,
        fallbackSource: PROXY_FALLBACK_ENABLED ? PROXY_FALLBACK_SOURCE : null,
        fallbackMax: PROXY_FALLBACK_MAX,
        fallbackLastRefresh,
        fallbackLastError,
      },
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
    // `nodes` is a plain object, so nodes["__proto__"] is Object.prototype —
    // truthy — and sailed straight past the unknown-node check below, queueing a
    // shell job for a host that does not exist. /api/node/register and
    // /api/node/report already gate on validHost() for exactly this reason; this
    // read did not. Admin-gated, so low impact, but it costs one line to close.
    if (!validHost(hostname)) return res.status(400).json({ error: "hostname and command required" });
    if (!Object.prototype.hasOwnProperty.call(nodes, hostname)) return res.status(404).json({ error: "unknown node" });
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
      : findUserByUsername(username);
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

  // ===== BILLING (per-tier price, tick every minute, first machine free, auto-stop at 0) =====
  setInterval(() => {
    try {
      // Bill `stopping` too. A guest whose shutdown is slow or stuck is still
      // consuming the host, so excluding it handed out free compute for as long
      // as the shutdown hung -- up to the 900s SSH timeout, and indefinitely for
      // a guest that ignores ACPI.
      const runningVms = all<any>(`SELECT * FROM vms WHERE state IN ('running','stopping')`);
      const runningSessions = all<any>(`SELECT * FROM sessions WHERE state IN ('running','stopping')`);
      // Every live machine, grouped by owner, each carrying its per-minute price
      // in balance_minutes (= its tier's USD/hr; a $5/hr machine burns 5/min).
      const perUser = new Map<string, { kind: "vm" | "session"; row: any; price: number }[]>();
      for (const r of runningVms) {
        const arr = perUser.get(r.user_id) ?? []; arr.push({ kind: "vm", row: r, price: rowPrice(r, "linux-vm") }); perUser.set(r.user_id, arr);
      }
      for (const s of runningSessions) {
        const arr = perUser.get(s.user_id) ?? []; arr.push({ kind: "session", row: s, price: rowPrice(s, "gpu") }); perUser.set(s.user_id, arr);
      }
      for (const [userId, machines] of perUser) {
        const acct = one<any>("SELECT unlimited, balance_minutes FROM users WHERE id=?", userId);
        if (!acct || acct.unlimited) continue; // unlimited accounts never bill or auto-stop
        // Spare the oldest FREE_MACHINES across ALL tiers, then bill each of the
        // rest at ITS tier's rate. Oldest-first keeps the free slot stable.
        const mine = machines.sort((a, b) => Number(a.row.created_at) - Number(b.row.created_at));
        const billableRows = mine.slice(FREE_MACHINES);
        if (billableRows.length === 0) continue;
        // Integer column: sum the per-machine prices and round the total.
        const charge = Math.round(billableRows.reduce((sum, m) => sum + m.price, 0));
        if (charge <= 0) continue;
        q("UPDATE users SET balance_minutes = MAX(0, balance_minutes - ?) WHERE id=?", charge, userId);
        const u = one<any>("SELECT balance_minutes FROM users WHERE id=?", userId);
        if (u && u.balance_minutes <= 0) {
          // Spare the free allowance. Stopping every machine at zero balance
          // contradicted the "your first machine is free" promise the 402 on
          // the provision routes makes -- a customer who ran out of credit lost
          // the machine they were still entitled to. Oldest machines are the
          // ones kept, so the free slot is stable rather than arbitrary.
          for (const { kind, row } of billableRows) {
            if (row.state === "stopping") continue; // already on its way down
            if (kind === "vm") {
              q("UPDATE vms SET state='stopping' WHERE id=?", row.id);
              // Verify it actually stopped. Blindly writing 'stopped' recorded a
              // live guest as off: uncounted, unbilled, still on the host. Route
              // the shutdown on the row's kind (pct for LXC, qm for KVM).
              const isPct = rowKind(row) === "pct";
              void (async () => {
                let r = isPct ? await stopCt(row.vm_id) : await stopVm(row.vm_id);
                if (!r.ok) r = await pve([isPct ? "pct" : "qm", "stop", String(row.vm_id)]);
                if ((isPct ? await ctStatus(row.vm_id) : await vmStatus(row.vm_id)) === "running") {
                  console.error(`[billing] vmid ${row.vm_id} would not stop; leaving 'stopping' so it stays billed`);
                  return;
                }
                q("UPDATE vms SET state='stopped' WHERE id=?", row.id);
              })();
            } else {
              q("UPDATE sessions SET state='stopping' WHERE id=?", row.id);
              dispatchJob(row.node_hostname, "destroy_ubuntu", "", { instanceId: row.instance_id });
            }
          }
        }
      }
    } catch (e) { console.error("[billing]", e); }
  }, BILLING_TICK_MS);

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
    // express.static would otherwise serve dist/admin.html directly, defeating
    // the ?token= gate on /admin entirely: the admin SPA was reachable
    // anonymously at /admin.html, handing out the exact admin API shape.
    app.use((req, res, next) => {
      if (/^\/admin\.html\/?$/i.test(req.path)) return res.status(404).send("Not found");
      next();
    });
    app.use(express.static(distPath, {
      setHeaders: (res, filePath) => { if (filePath.endsWith("index.html")) res.setHeader("Cache-Control", "no-store"); },
    }));
    // An unmatched /api/* path fell through to the SPA and returned 200 with
    // HTML, so a typo'd or removed endpoint was indistinguishable from a real
    // one. Answer as an API, not as the app.
    app.use("/api", (_req, res) => res.status(404).json({ error: "not found" }));
    app.get("*", (req, res) => {
      if (req.path.startsWith("/admin")) return res.status(404).send("Not found");
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Kick the egress-proxy health prober. Same cadence idiom as the reconciler:
  // one pass now, then every PROXY_REFRESH_MS. Until the first pass completes
  // nothing is healthy, so a spawn in that window is refused rather than
  // silently un-proxied.
  if (proxyEndpoints.length === 0) {
    console.error(`[proxy] no PROXY_ENDPOINTS configured — sessions have no clean egress. REQUIRE_CLEAN_PROXY=${REQUIRE_CLEAN_PROXY ? "1 (spawns will be refused)" : "0 (spawns will proceed UNPROXIED)"}`);
  } else if (PROXY_FORBIDDEN_EGRESS.size === 0) {
    console.error("[proxy] PROXY_FORBIDDEN_EGRESS is unset — the anonymity check cannot run, so no endpoint can be marked healthy. Set it to the operator's WAN IP(s).");
  }
  if (PROXY_FALLBACK_ENABLED) {
    console.error(`[proxy] fallback tier ENABLED: up to ${PROXY_FALLBACK_MAX} candidates per refresh from ${PROXY_FALLBACK_SOURCE}. These are UNTRUSTED third-party proxies whose operators can read and modify tenant traffic; they are used only when NO operator exit is clean, and are held to the same forbidden-egress check.`);
  } else {
    console.log("[proxy] fallback tier disabled (PROXY_FALLBACK_ENABLED=0) — tier 1 only.");
  }
  refreshProxyPool();
  setInterval(refreshProxyPool, PROXY_REFRESH_MS);

  // Keep vm rows honest against the host. A reconcile failure must never take
  // the gateway down, so errors are logged and swallowed.
  const runReconcile = () => reconcileVms().catch((e) => console.warn("[reconcile] pass failed:", e?.message));
  runReconcile();
  setInterval(runReconcile, VM_RECONCILE_MS);

  // GPU session queue promoter. Same idiom as the billing/reconcile sweeps:
  // expire stale queued rows and promote the rest oldest-first as the shared
  // card frees. A pass failure must never take the gateway down.
  const runPromote = () => promoteQueuedSessions().catch((e) => console.warn("[gpu-queue] pass failed:", e?.message));
  setInterval(runPromote, GPU_QUEUE_SWEEP_MS);
  console.log(`[gpu-queue] promoter every ${GPU_QUEUE_SWEEP_MS}ms | max ${MAX_GPU_SESSIONS} live sessions | queue TTL ${Math.round(GPU_QUEUE_TTL_MS / 60000)}m | reclaim-idle ${HYPERSWAP_RECLAIM_IDLE ? "on" : "off"}`);

  // Confirm the configured templates actually exist and are templates. Without
  // this a typo'd VMID only surfaces when a tenant provisions: the clone fails
  // in the background and their machine lands in `failed` with no operator
  // signal. Non-blocking and advisory -- a hypervisor that is briefly
  // unreachable must not stop the gateway from serving.
  void (async () => {
    // One check per clone-backed tier, using the right config command (`qm
    // config` for KVM, `pct config` for LXC).
    for (const t of CATALOG) {
      if (t.kind === "gpu" || !t.template) continue;
      const cmd = t.kind === "pct" ? "pct" : "qm";
      const r = await pve([cmd, "config", String(t.template)]);
      if (!r.ok) { console.warn(`[templates] could not verify ${t.key} template ${t.template}: ${r.out.slice(0, 120).trim()}`); continue; }
      const name = r.out.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? r.out.match(/^hostname:\s*(.+)$/m)?.[1]?.trim() ?? "?";
      if (!/^template:\s*1\s*$/m.test(r.out)) {
        console.error(`[templates] ${t.key} template ${t.template} ("${name}") is NOT a template — cloning it will fail`);
      } else {
        console.log(`[templates] ${t.key} -> ${t.template} "${name}" ok`);
      }
    }
  })();

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[VortexGPU] rent-a-PC gateway on :${PORT}`);
    console.log(`[VortexGPU] Proxmox ${PVE_HOST} | tiers: ${CATALOG.map((t) => `${t.key}=$${t.priceUsdPerHour}/hr(${t.kind}${t.template ? " " + t.template : ""})`).join(" | ")}`);
    console.log(`[VortexGPU] GPU SKU: ${GPU_SKU} | base $${PRICE_USD_PER_HOUR}/hr | ${FREE_MACHINES} free machine(s)`);
  });
  server.on("upgrade", sessionProxy.upgrade);
}

startServer().catch((e) => { console.error(e); process.exit(1); });
