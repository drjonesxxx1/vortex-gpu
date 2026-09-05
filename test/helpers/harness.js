// Black-box test harness for the VortexGPU gateway.
//
// PRODUCTION SAFETY — every rule below is load-bearing, do not relax one:
//   * We NEVER touch the live service. No systemctl, no `npm start`, no signal
//     to any pid we did not spawn ourselves.
//   * We NEVER build into dist/. The bundle goes to a mkdtemp() directory under
//     the OS temp dir and is deleted afterwards.
//   * We NEVER open data/vortex.db. Each server gets a brand-new SQLite file in
//     its own temp cwd.
//   * We NEVER bind or call port 3000. Each server takes a free port from the
//     3990-3999 spare range (falling back to an ephemeral port).
//   * We NEVER reach real infrastructure. `ssh` is shimmed on the child's PATH
//     (see sshShim below), so the Proxmox driver, the reconciler and the
//     template check all talk to a local stub instead of 10.30.20.85.
//
// The suite is deliberately black-box: it boots the real bundled server as a
// child process and drives it over HTTP. That keeps it valid across an internal
// refactor of server.ts (a modularisation is planned).

import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { after, before } from "node:test";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const ESBUILD = path.join(REPO_ROOT, "node_modules", ".bin", "esbuild");

// The live gateway listens on 3000. Nothing in this file may ever use it.
const FORBIDDEN_PORT = 3000;
const PORT_RANGE = [3990, 3991, 3992, 3993, 3994, 3995, 3996, 3997, 3998, 3999];

/** Children we spawned, so a crashing test run cannot leave one behind. */
const CHILDREN = new Set();
process.on("exit", () => {
  for (const c of CHILDREN) { try { c.kill("SIGKILL"); } catch { /* already gone */ } }
});

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

let cachedBundle = null;

/**
 * Bundle server.ts once per test process, into a scratch path. Never dist/.
 * Returns the path to the built server.cjs.
 */
export function buildBundle() {
  if (cachedBundle) return cachedBundle;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-build-"));
  const out = path.join(dir, "server.cjs");
  execFileSync(ESBUILD, [
    path.join(REPO_ROOT, "server.ts"),
    "--bundle", "--platform=node", "--format=cjs", "--packages=external",
    `--outfile=${out}`,
  ], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
  cachedBundle = out;
  process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return out;
}

// ---------------------------------------------------------------------------
// ports
// ---------------------------------------------------------------------------

function tryListen(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

export async function freePort() {
  // Shuffled so parallel test files do not all race for 3990 first.
  const candidates = [...PORT_RANGE].sort(() => Math.random() - 0.5);
  for (const p of candidates) {
    if (p === FORBIDDEN_PORT) continue;
    if (await tryListen(p)) return p;
  }
  // Every spare port busy (parallel test files) — take an ephemeral one.
  const s = net.createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  if (port === FORBIDDEN_PORT) throw new Error("refusing to use port 3000");
  return port;
}

// ---------------------------------------------------------------------------
// ssh shim — the only boundary to real infrastructure
// ---------------------------------------------------------------------------

// server.ts drives Proxmox with execFile("ssh", [...]). Putting this script
// first on the child's PATH means `qm clone|start|shutdown|destroy|status|list`
// never leave the box. `qm list` deliberately prints only a header: the
// reconciler treats "no parseable guests" as a no-op, so it can never rewrite a
// seeded vm row underneath a test.
const SSH_SHIM = `#!/bin/sh
# Test double for ssh(1). Never contacts a network.
if [ -n "$SSH_SHIM_LOG" ]; then echo "$*" >> "$SSH_SHIM_LOG"; fi
case "$*" in
  *"qm list"*)     echo "      VMID NAME                 STATUS     MEM(MB)    BOOTDISK(GB) PID"; exit 0 ;;
  *"qm config"*)   echo "name: test-template"; echo "template: 1"; exit 0 ;;
  *"qm status"*)   echo "status: \${SSH_SHIM_VM_STATUS:-stopped}"; exit 0 ;;
  *"qm stop"*)     echo "stopped"; exit 0 ;;
  *"qm destroy"*)
    if [ "$SSH_SHIM_DESTROY_FAIL" = "1" ]; then echo "destroy failed: shim" >&2; exit 1; fi
    if [ "$SSH_SHIM_DESTROY_FAIL" = "missing" ]; then echo "Configuration file does not exist" >&2; exit 1; fi
    echo "destroyed"; exit 0 ;;
  *"qm shutdown"*) echo "shutdown"; exit 0 ;;
  *"qm start"*)    echo "started"; exit 0 ;;
  *"qm clone"*)    echo "cloned"; exit 0 ;;
  *) exit 0 ;;
esac
`;

// ---------------------------------------------------------------------------
// server lifecycle
// ---------------------------------------------------------------------------

async function bootServer(opts = {}) {
  const bundle = buildBundle();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vortex-test-"));
  const port = await freePort();

  fs.mkdirSync(path.join(dir, "data"));
  fs.mkdirSync(path.join(dir, "dist"));
  // NODE_ENV=production makes the server serve dist/ instead of booting a Vite
  // dev server. It only ever reads these for non-API routes.
  fs.writeFileSync(path.join(dir, "dist", "index.html"), "<!doctype html><title>test</title>");
  fs.writeFileSync(path.join(dir, "dist", "admin.html"), "<!doctype html><title>admin</title>");
  // The bundle is built with --packages=external, so `require("express")` must
  // resolve. Symlink (never copy, never write into) the repo's node_modules.
  fs.symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");

  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir);
  const sshPath = path.join(binDir, "ssh");
  fs.writeFileSync(sshPath, SSH_SHIM, { mode: 0o755 });

  fs.copyFileSync(bundle, path.join(dir, "server.cjs"));

  const adminToken = crypto.randomBytes(24).toString("hex");
  const nodeSecret = crypto.randomBytes(24).toString("hex");
  const webhookSecret = crypto.randomBytes(24).toString("hex");
  const sshLog = path.join(dir, "ssh.log");

  const env = {
    PATH: `${binDir}:${process.env.PATH}`,
    HOME: dir,
    NODE_ENV: "production",
    PORT: String(port),
    ADMIN_TOKEN: adminToken,
    NODE_SECRET: nodeSecret,
    BTCPAY_WEBHOOK_SECRET: webhookSecret,
    // No BTCPay by default: create-invoice 500s rather than dialling anything.
    BTCPAY_URL: "https://127.0.0.1:1",
    BTCPAY_API_KEY: "",
    BTCPAY_STORE_ID: "",
    BTCPAY_PUBLIC: "https://btcpay.invalid",
    // Owner seed skipped (unset password) so the DB starts genuinely empty.
    OWNER_SEED_PASSWORD: "",
    // Only ever reached through the ssh shim above.
    PVE_HOST: "proxmox.invalid",
    PVE_USER: "nobody",
    // Distinct from the real "nightmare" so nothing here can be confused for it.
    SESSION_NODE: "testnode",
    MIN_FREE_VRAM_MB: "2048",
    CREDIT_ON_PROCESSING: "0",
    FREE_MACHINES: "1",
    // Default express setting: loopback is trusted, so tests can pick their own
    // rate-limit bucket with X-Forwarded-For (see helpers/http.js).
    TRUST_PROXY: "loopback, linklocal, uniquelocal",
    SSH_SHIM_LOG: sshLog,
    ...opts.env,
  };

  const child = spawn(process.execPath, [path.join(dir, "server.cjs")], {
    cwd: dir, env, stdio: ["ignore", "pipe", "pipe"],
  });
  CHILDREN.add(child);

  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });

  let exited = null;
  child.on("exit", (code, signal) => { exited = { code, signal }; });

  const baseUrl = `http://127.0.0.1:${port}`;

  const stop = async () => {
    CHILDREN.delete(child);
    if (!exited) {
      child.kill("SIGKILL"); // our own child, by handle — never a pid we found
      await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 5000))]);
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  // Poll for readiness with a deadline rather than sleeping.
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (exited) {
      await stop();
      throw new Error(`test server exited early (code=${exited.code} signal=${exited.signal})\n${log}`);
    }
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`test server did not become healthy in 30s\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    dir, port, baseUrl, env, child, stop,
    adminToken, nodeSecret, webhookSecret,
    dbPath: path.join(dir, "data", "vortex.db"),
    sshLog,
    logs: () => log,
    sshCalls: () => (fs.existsSync(sshLog) ? fs.readFileSync(sshLog, "utf8").trim().split("\n").filter(Boolean) : []),
  };
}

/**
 * Boot a throwaway gateway. Returns a context with the temp dir, the throwaway
 * DB path, the generated secrets and stop().
 *
 * Test files run in parallel, so two of them can pick the same spare port
 * between the availability check and the child's listen(). That is the only
 * expected boot failure, and it is retried rather than reported as flake.
 */
export async function startServer(opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await bootServer(opts);
    } catch (e) {
      lastErr = e;
      if (!/EADDRINUSE/.test(String(e?.message))) throw e;
    }
  }
  throw lastErr;
}

/**
 * Register before/after hooks that boot and tear down a server for the
 * enclosing describe block. Returns a context object filled in by before().
 *
 * Each describe gets its own process, DB and temp dir, so no test file or block
 * shares mutable state with another.
 */
export function useServer(opts = {}) {
  const ctx = {};
  before(async () => { Object.assign(ctx, await startServer(opts)); });
  after(async () => { if (ctx.stop) await ctx.stop(); });
  return ctx;
}
