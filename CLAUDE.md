# VortexGPU — working notes for Claude

Anonymous, no-KYC, Bitcoin-paid GPU rental. Express + Vite SPA + SQLite gateway
at `10.30.20.127:3000`, fronted by Cloudflare.

**This is LIVE production with real customers and real Bitcoin.** Read the
safety rules before touching anything.

## Safety rules (non-negotiable)

- **Never** `systemctl restart/stop vortexgpu`, `npm start`, or kill the node
  process directly. Deploy with `bash deploy.sh` — it has a health check and
  automatic rollback.
- **Never** build into `dist/`. The live service serves from it. Use
  `npx vite build --outDir <scratch>` and a scratch `esbuild --outfile`.
- **Never** write to `data/vortex.db`. It holds real balances and invoices.
  Read-only inspection is fine. To test mutations, run a bundle from a scratch
  cwd with its own SQLite file on a spare port (3996–3999).
- **Never** point a mutating test at port 3000.
- **Never** call `POST /api/vms/provision` casually — it clones a real KVM
  guest on Proxmox. `/api/session/spawn` starts a real container on a GPU box.
- Secrets live in `.env` (mode 600) and nowhere else. Every secret was once
  duplicated into `README.md`, `.env.example` and `server.ts` as fallback
  defaults; that was cleaned up. Do not reintroduce a fallback for a secret —
  the app is a public GitHub repo.

## Architecture

Three provisioning paths, **not** interchangeable:

| Path | Endpoint | Target | GPU? |
|---|---|---|---|
| Ubuntu GPU session | `POST /api/session/spawn` | `nightmare` (Linux, hardcoded via `SESSION_NODE`) | **yes** — Docker + Xvfb/noVNC, in-browser |
| Windows VM | `POST /api/vms/provision` os=windows | Proxmox `.85` | no |
| Linux VM | `POST /api/vms/provision` os=linux | Proxmox `.85` | no |

- Only the Ubuntu session is GPU-attached. The KVM guests have **no**
  passthrough. The `sku` column on a vm row is a marketing label, not evidence.
- `nightmare` is the only Linux node running the session agent, so pinning
  sessions to it is correct, not a load-balancing bug. `light_reaper` is
  Windows and cannot host them.
- Proxmox is driven over SSH (`ssh root@10.30.20.85 qm ...`). Repeated logins
  can trip fail2ban — back off rather than retrying hard.

## GPU capacity

The RTX 4080 SUPER on `nightmare` is **shared with HyperSwap** (an ollama
`llama-server` on the same box) which loads ~10–15GB models. Free VRAM swings
between ~500MB and ~16GB depending on whether a model is resident.

`/api/session/spawn` preflights real `nvidia-smi` telemetry and returns 503
with the actual figure when free VRAM < `MIN_FREE_VRAM_MB`, charging nothing.
Do not "fix" a 503 here — it is the guard working.

## Honesty rules for UI copy

This codebase has repeatedly shipped false product claims. All were removed;
do not reintroduce them:

- a fabricated `aggregateRating: 4.8 / 127 reviews` in JSON-LD
- a fake "GPU LOAD: 74%" readout
- "dedicated passthrough — the card is yours for the session" (it is shared)
- Windows/Linux VMs advertised as running CUDA (they have no GPU)
- a "Dedicated passthrough, not shared" dashboard tile

Every user-facing number must come from `GET /api/health` at render time — no
hardcoded prices, specs, or OS versions. Guest OS names come from
`windowsLabel`/`linuxLabel` so swapping a Proxmox template cannot leave the
storefront advertising an OS tenants do not get. `GPU_SKU` must name the card
actually provided.

Claims that ARE verified: the Linux template is Debian 12 (read from
`/etc/os-release` on the template disk), and the GPU is a real RTX 4080 SUPER.

## Deploying

```bash
bash deploy.sh          # current HEAD
bash deploy.sh <commit> # a specific commit
```

Builds from a clean git checkout, so uncommitted working-tree changes never
ship. Backs up `dist/`, restarts, health-checks 15×, auto-rolls-back on
failure, keeps the last 3 snapshots. **A restart logs everyone out** — bearer
tokens are in-memory by design.

Editing `server.ts` changes nothing until a redeploy; the running process uses
`dist/server.cjs`.

## Conventions

- `server.ts` is one file (~1300 lines) and stays that way for now. Prefer
  surgical, reviewable changes over restructuring.
- Use the existing helpers: `q()` / `one()` / `all()` for SQLite,
  `str()` / `num()` for coercion, `rateLimit()`, `{error:"..."}` responses.
- Admin routes return **404** when unauthorized, not 403 — the surface is
  deliberately undiscoverable.
- Verify with `npx tsc --noEmit` (must exit 0) before every commit.

## Gotchas

- `/api/sessions` returns a **bare array**, not `{sessions:[...]}`.
- `vm.ip` is NULL while `provisioning` and set when the clone completes —
  render a waiting state, never the string "null".
- Deleting a machine runs `qm destroy` **before** dropping the DB row, so a
  failed reclaim keeps the row for retry instead of stranding a guest.
- A reconciler re-reads `qm list` every `VM_RECONCILE_MS` and corrects drifted
  vm states. It only ever UPDATEs `state`.
- A NULL `password_hash` is a hard 403 on login (it must never be claimable —
  that was an account-takeover hole). Recover via
  `POST /api/admin/set-password`.
- IP rate limits depend on `TRUST_PROXY`. Wrong values are dangerous in both
  directions: `true` lets anyone spoof their key; `false` behind Cloudflare
  buckets every user together.

## Testing

`MANUAL-QA.md` covers the browser-only surface. **No browser is available on
this box** — puppeteer's download hosts are blocked and chromium ships as a
non-functional snap — so the rendered UI has never been visually verified.
Treat any claim about layout, focus traps, or mobile rendering as unverified.
