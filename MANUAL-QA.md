# Manual QA — browser-only checks

Everything on the API surface is covered by automated checks (see
`apitest.sh` / `apitest2.sh` in the scratchpad, 43 assertions). **What no
automated check covers is the rendered UI**: no browser was available on the
gateway box (puppeteer's Chrome download hosts are blocked and Ubuntu ships
chromium as a snap, which does not run in the container).

So the items below are the genuinely unverified ones. Open
`http://10.30.20.127:3000` and work down the list.

## 1. Landing page
- [ ] Page renders; hero, pricing, FAQ, footer all present
- [ ] Price and "first machine free" match the server (`GET /api/health`:
      `priceUsdPerHour`, `freeMachines`)
- [ ] GPU SKU shown matches `gpuSku`
- [ ] No fabricated numbers anywhere (there used to be a fake "4.8 / 127
      reviews" rating and a fake "GPU LOAD: 74%" — both were removed; confirm
      they have not come back)
- [ ] Resize to a phone width: no horizontal scrolling, nav collapses

## 2. Auth
- [ ] Register a throwaway account; it logs you straight in
- [ ] Password under 6 chars is rejected client-side with a visible message
- [ ] Username outside `^[a-zA-Z0-9_.-]{3,32}$` is rejected
- [ ] Log out, log back in
- [ ] Wrong password shows the server's error, not a blank failure

## 3. Capacity display  ← most likely to be wrong
The GPU is shared with HyperSwap, so free VRAM moves around (~6 GB typical,
briefly near zero during a model swap).
- [ ] Dashboard shows real available VRAM, not the full 16 GB
- [ ] While free VRAM < `minFreeVramMb` (2048), the GPU-session deploy button
      is disabled **and says why** ("GPU busy — N MiB free, needs M MiB")
- [ ] If you manage to click during a race, the 503 is surfaced legibly and
      states nothing was charged
- [ ] Node offline reads differently from "at capacity"

## 4. Deploy + delete a machine
- [ ] Deploy an Ubuntu GPU session; card appears as `provisioning`
- [ ] It reaches `running` (takes ~30–60s) and the desktop opens in-browser
- [ ] Stop it; card becomes `stopped`
- [ ] **Delete** now appears (it must NOT appear while running)
- [ ] Delete asks for confirmation before doing anything
- [ ] Confirm → the card disappears from the list
- [ ] Cancel → nothing happens
- [ ] Deleting a running machine is refused with "stop the machine first"

## 5. Settings
- [ ] Gear icon opens Settings
- [ ] Account: username, member-since, BTC address; copy button works
- [ ] Change password: wrong current password → clear error
- [ ] Change password: mismatched confirm → caught client-side
- [ ] Change password succeeds, **you stay logged in**, and the new password
      works on next login
- [ ] Billing: invoice history renders; empty state is real, not a blank box
- [ ] "Log out everywhere" asks for confirmation, then drops you on the
      sign-in form

## 6. Accessibility
- [ ] Tab through the page: focus is always visible
- [ ] Dialogs trap focus; Escape closes them; focus returns to the opener
- [ ] Icon-only buttons announce themselves (screen reader or inspect
      `aria-label`)
- [ ] With OS "reduce motion" on, the 3D hero stops animating

## 7. Console
- [ ] DevTools console is free of errors during all of the above
      (font/favicon 404s are fine)

---

## Still untested anywhere: Proxmox VM provisioning

`POST /api/vms/provision` clones a **real KVM guest** on Proxmox (`.85`), so it
was deliberately excluded from automated testing. The Ubuntu GPU session path
*is* verified end-to-end against `nightmare`, but this one is not:

- [ ] Deploy a Linux VM; it reaches `running`
- [ ] The returned SSH host/port actually accepts a connection
- [ ] Deploy a Windows VM; RDP works
- [ ] Stop and delete both; confirm the guest is gone in the Proxmox UI
      (a leaked guest here costs real disk and RAM)

Known gap: `/api/me` does not return the VM host address, so the dashboard
cannot show users where to connect. Fixing that needs a backend change.
