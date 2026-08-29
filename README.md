# VortexGPU — GPU Rental Platform (Production)

No-KYC, BTC-paid, browser-access GPU machines. Verified live 2026-08-28.

> **Accuracy note:** this file documents what the code actually does. Earlier
> revisions described a ComfyUI-only, load-balanced fleet; that was never what
> `server.ts` implemented. Keep this in sync — it is read as a spec.

## Architecture

```
                        ┌──────────────────────────────────────────┐
   Tenant browser ────► │  VortexGPU Gateway (CT 731, .127:3000)    │
                        │  Express + Vite SPA + SQLite              │
                        │  • public SPA (auth/deploy/settings)      │
                        │  • real BTCPay invoices + webhook settle  │
                        │  • hidden admin /admin?token=             │
                        │  • /session/<id>/ noVNC reverse proxy     │
                        └───────────────┬──────────────────────────┘
                                        │ LAN (poll, X-NODE-SECRET)
        ┌───────────────────────────────┼───────────────────────────────┐
        ▼                               ▼                               ▼
 ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
 │ nightmare (.128)     │  │ light_reaper (.186)  │  │ Proxmox (.85)        │
 │ LINUX · RTX 4080S    │  │ WINDOWS · RTX 3070   │  │ KVM host             │
 │ docker + noVNC       │  │ vortex-node-agent.ps1│  │ full VM clones       │
 │ → provision_ubuntu   │  │ → provision_comfyui  │  │ → windows RDP        │
 │ → destroy_ubuntu     │  │ → shell              │  │ → linux SSH          │
 └──────────────────────┘  └──────────────────────┘  └──────────────────────┘
```

## The three provisioning paths (they are NOT interchangeable)

| Path | Endpoint | Target | What the tenant gets |
|------|----------|--------|----------------------|
| Ubuntu GPU session | `POST /api/session/spawn` | `nightmare` only (hardcoded) | Docker container + Xvfb/noVNC desktop, GPU attached, reached in-browser via `/session/<instanceId>/` |
| Proxmox VM | `POST /api/vms/provision` | Proxmox `.85` | Full KVM clone — Windows RDP or Linux SSH on a dedicated port |
| ComfyUI instance | `provision_comfyui` job | Windows nodes | Isolated ComfyUI port + data dirs (legacy path; not exposed in the current SPA) |

**Node targeting is not load-balanced.** `/api/session/spawn` hardcodes
`hostname = "nightmare"` because it is the only Linux node running the Docker /
noVNC session agent. `light_reaper` is Windows and cannot host these sessions.
Adding a second Linux node means replacing that constant with real selection.

## GPU capacity (important)

`nightmare`'s RTX 4080 SUPER is **shared with HyperSwap** (an ollama
`llama-server` on the same box). With a model resident, ollama holds ~15.2 GB of
the 16 GB card, leaving too little for a tenant to do GPU work.

`POST /api/session/spawn` therefore preflights real `nvidia-smi` telemetry
(`memTotalMb - memUsedMb`) and returns **503 with the actual free figure**
rather than handing over — and billing for — a GPU machine that cannot compute.

- `MIN_FREE_VRAM_MB` (default `2048`) — required free VRAM; set `0` to disable.
- `GET /api/health` reports `gpuVramFreeMb` / `gpuVramTotalMb` / `minFreeVramMb`.

To free VRAM when HyperSwap is idle, shorten ollama's keep-alive on `nightmare`
(default there is 30m, so it pins VRAM long after the last request):

```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
printf '[Service]\nEnvironment="OLLAMA_KEEP_ALIVE=5m"\n' \
  | sudo tee /etc/systemd/system/ollama.service.d/vortex-vram.conf
sudo systemctl daemon-reload && sudo systemctl restart ollama
```

Reverse it by deleting that file and restarting ollama.

## Session isolation

Each Ubuntu session gets its own container (`vortex-<instanceId>`), its own
host port (6090–6190), and its own generated VNC password. The
`/session/<instanceId>/` proxy is **unauthenticated by design** — noVNC loads it
as a top-level navigation with no `Authorization` header, so the `instanceId`
(16 random bytes) is itself the capability. It is also gated on session
`state === 'running'`, enforced in the proxy router so WebSocket upgrades cannot
bypass it. Capability URLs still leak via browser history and `Referer`;
real per-session auth is the outstanding hardening item.

## BTCPay (real payments)

- Store: `BTCPAY_STORE_ID` (see `.env`)
- API key: `BTCPAY_API_KEY` (see `.env`; scoped: create/view invoices)
- Webhook: id in BTCPay store settings → `POST /api/btcpay/webhook`
- Flow: create USD invoice → tenant pays at checkout link → BTCPay fires
  `InvoiceSettled` webhook → gateway credits `users.balance_minutes` in SQLite.
- Dust threshold: $1 minimum (below ~$1 is BTC dust). Price = $1/hr.

## Endpoints

Auth column: **none** = public; **bearer** = user token from login/register
(`Authorization: Bearer <token>`, or `X-Auth-Token`); **admin** = `ADMIN_TOKEN`
as a bearer token, 404 when absent so the surface is not discoverable;
**node** = `X-NODE-SECRET`; **HMAC** = BTCPay signature over the raw body.

| Path | Auth | Purpose |
|------|------|---------|
| `GET /api/health` | none | status, price, limits, live GPU VRAM headroom |
| `POST /api/auth/register` | none | create account (username + password only) |
| `POST /api/auth/login` | none | issue bearer token |
| `POST /api/auth/logout` | bearer | revoke the calling token |
| `POST /api/auth/logout-all` | bearer | revoke every token for this user |
| `POST /api/auth/change-password` | bearer | rotate password, revoke other tokens |
| `GET /api/me` | bearer | balance, machines, sessions, limits |
| `GET /api/account` | bearer | account detail (never returns password_hash) |
| `GET /api/invoices` | bearer | this user's invoices only |
| `POST /api/btcpay/create-invoice` | bearer | real BTCPay invoice |
| `POST /api/btcpay/webhook` | HMAC | credit balance on InvoiceSettled |
| `POST /api/session/spawn` | bearer | Ubuntu GPU session (VRAM preflight) |
| `GET /api/sessions` | bearer | this user's sessions (bare array) |
| `POST /api/session/destroy` | bearer | stop a session |
| `POST /api/session/delete` | bearer | remove a stopped session (409 if running) |
| `POST /api/vms/provision` | bearer | clone a Proxmox VM (Windows RDP / Linux SSH) |
| `POST /api/vms/destroy` | bearer | shut a VM down |
| `POST /api/vms/delete` | bearer | reclaim the guest + row (409 if running) |
| `GET /session/:instanceId/` | capability | noVNC desktop proxy; gated on state=running |
| `GET /api/proxy/pool` | none | public proxy pool sample |
| `POST /api/node/register` | node | GPU box registers |
| `POST /api/node/report` | node | nvidia-smi telemetry |
| `GET /api/node/jobs` | node | poll for pending jobs |
| `POST /api/node/jobs/:id/result` | node | report job result |
| `GET /admin?token=` | admin | hidden admin SPA (404 without token) |
| `GET /api/admin/state` | admin | nodes, jobs, vms, users, invoices |
| `POST /api/admin/gpu/run` | admin | run a shell job on a node (RCE by design) |
| `POST /api/admin/credit` | admin | adjust a user's balance |
| `POST /api/admin/set-password` | admin | recover an account with no password set |

Rate limited: login (per IP **and** per targeted username), register, invoice
creation, change-password. The IP-keyed limits are only as trustworthy as
`TRUST_PROXY` — see `.env.example`.

## Operations

**Deploying.** `bash deploy.sh [commit]` builds from a clean git checkout (so
uncommitted working-tree changes never ship), backs up `dist/`, restarts,
health-checks, and **rolls back automatically** if `/api/health` does not come
back 200. It keeps the last 3 rollback snapshots. A restart logs everyone out —
bearer tokens are in-memory by design.

**VM lifecycle.** `destroy` shuts a guest down; `delete` reclaims it. Delete
runs `qm destroy --purge` **before** dropping the DB row, so a failed reclaim
keeps the row for retry instead of stranding a guest. A guest that is already
gone counts as success, which also heals rows whose guest was removed by hand.
Running machines cannot be deleted (409) — stop them first.

**Drift reconciliation.** The `vms` table is only written when a request
happens, so it drifts from the hypervisor: a guest started or stopped outside
the gateway keeps a stale state, and a guest deleted by hand leaves a phantom
row. Every `VM_RECONCILE_MS` the gateway re-reads `qm list` and corrects state.
It only ever UPDATEs `state` — never deletes a row, never changes anything on
the host — and skips rows younger than 15 minutes so a clone in flight is never
marked failed.

**Recovering a locked-out account.** A NULL/blank `password_hash` is a hard 403
on login (it must never be claimable — that was an account-takeover hole). Set
one out-of-band:

```bash
curl -X POST http://127.0.0.1:3000/api/admin/set-password \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{"username":"someuser","newPassword":"..."}'
```

**Testing.** The API suites live outside the repo; `MANUAL-QA.md` covers what
automation cannot reach (the rendered UI). Never point a mutating test at
port 3000 — run against a scratch cwd with its own SQLite file on another port,
and never exercise `/api/vms/provision` casually: it clones a real KVM guest.

## Windows GPU agent

On each GPU host: `C:\vortex\vortex-node-agent.ps1` (scheduled task
`VortexGPUNodeAgent`, ONSTART). It registers, streams telemetry every 5s, and
handles `provision_comfyui` / `destroy_instance` / `shell` jobs.

## Deploy notes

- CT 730 = template, CT 731 = live clone @ `10.30.20.127:3000`.
- Node.js 22 (native `node:sqlite`), systemd `vortexgpu`.
- Admin: `http://10.30.20.127:3000/admin?token=<ADMIN_TOKEN>` (in `/opt/vortexgpu/.env`).
- Secrets: `ADMIN_TOKEN`, `NODE_SECRET`, BTCPay keys → `/opt/vortexgpu/.env` (600).
