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

| Path | Auth | Purpose |
|------|------|---------|
| `POST /api/session` | none | No-KYC login → user row (120 min welcome bonus) |
| `GET /api/me?userId=` | none | balance + instances |
| `POST /api/btcpay/create-invoice` | none | real BTCPay invoice |
| `POST /api/btcpay/webhook` | BTCPay | settle invoice → credit balance |
| `POST /api/vms/provision` | none | allocate isolated ComfyUI on a GPU node |
| `POST /api/node/register` | X-NODE-SECRET | GPU box registers |
| `POST /api/node/report` | X-NODE-SECRET | nvidia-smi telemetry |
| `GET /api/node/jobs` | X-NODE-SECRET | poll for shell/provision/destroy jobs |
| `GET /admin?token=` | token | hidden admin SPA (404 without token) |
| `GET /api/admin/*` | Bearer | admin state, GPU jobs, credit, users |

## Windows GPU agent

On each GPU host: `C:\vortex\vortex-node-agent.ps1` (scheduled task
`VortexGPUNodeAgent`, ONSTART). It registers, streams telemetry every 5s, and
handles `provision_comfyui` / `destroy_instance` / `shell` jobs.

## Deploy notes

- CT 730 = template, CT 731 = live clone @ `10.30.20.127:3000`.
- Node.js 22 (native `node:sqlite`), systemd `vortexgpu`.
- Admin: `http://10.30.20.127:3000/admin?token=<ADMIN_TOKEN>` (in `/opt/vortexgpu/.env`).
- Secrets: `ADMIN_TOKEN`, `NODE_SECRET`, BTCPay keys → `/opt/vortexgpu/.env` (600).
