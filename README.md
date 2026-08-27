# VortexGPU — Anonymous GPU Rental Platform (Production)

No-KYC, BTC-paid, browser-access GPU machines. Each tenant provisions a
**completely isolated ComfyUI instance** on a shared physical GPU — they see a
clean private machine and never know the GPU is time-shared.

## Architecture

```
                        ┌──────────────────────────────────────────┐
   Tenant browser ────► │  VortexGPU Gateway (CT 731, .127:3000)  │
                        │  Express + Vite SPA + SQLite              │
                        │  • public SPA (login/provision/instances) │
                        │  • real BTCPay invoices + webhook settle  │
                        │  • hidden admin /admin?token=             │
                        └───────────────┬──────────────────────────┘
                                        │ LAN (poll, X-NODE-SECRET)
              ┌─────────────────────────┴─────────────────────────┐
              ▼                                                     ▼
   ┌────────────────────────┐                         ┌────────────────────────┐
   │ shadow-death (.128)    │                         │ GamingPC (.186)        │
   │ RTX 4080 SUPER 16GB    │                         │ RTX 3070               │
   │ vortex-node-agent.ps1  │                         │ vortex-node-agent.ps1  │
   │  → telemetry           │                         │  → telemetry           │
   │  → provision_comfyui   │                         │  → provision_comfyui   │
   │    (isolated port+dir) │                         │    (isolated port+dir) │
   └────────────────────────┘                         └────────────────────────┘
```

## Isolation model (how the GPU stays hidden)

One shared ComfyUI codebase per host (`C:\vortex\comfyui-base`), **N isolated
data dirs** (`C:\vortex\instances\<vm_id>\{user,output,input,models}`). Each
instance launches with its own `--port` and its own `--user-directory`,
`--output-directory`, `--input-directory`, so settings, checkpoints, and outputs
never cross tenant boundaries. The tenant's ComfyUI URL is
`http://<node-ip>:<port>` — they see a private, fresh machine. The physical RTX
is shared underneath and the VRAM load is load-balanced across tenants.

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
