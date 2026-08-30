import { useEffect, useState } from 'react';

/**
 * The public status model, shared by the landing page, the console and the
 * guide.
 *
 * Every field here comes straight off `GET /api/health` in server.ts. Nothing
 * in this module invents a number: when the gateway does not report something,
 * the derived state says "unknown" rather than filling in a plausible-looking
 * value.
 */
export interface Health {
  gpuNodesOnline: number; gpuNodesTotal: number; gpuSku: string;
  priceUsdPerHour: number; maxVmsPerUser: number; freeMachines: number;
  /** The single Linux node that hosts Ubuntu GPU sessions, plus its real VRAM
   *  headroom. That card is shared with another workload on the same box, so
   *  free VRAM genuinely moves — these are polled values, not constants.
   *  Optional because an older gateway may not send them yet; the UI then
   *  degrades to "capacity unknown" rather than inventing a number. */
  sessionNode?: string;
  sessionNodeOnline?: boolean;
  gpuVramFreeMb?: number;
  gpuVramTotalMb?: number;
  minFreeVramMb?: number;
}

/** MiB is the unit the gateway speaks, so every hard number stays MiB. Only the
 *  headline reading is rounded to GiB, where a human actually reads it faster. */
export function fmtVram(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GiB` : `${Math.round(mb)} MiB`;
}

export type CapacityState = 'unknown' | 'offline' | 'busy' | 'ready';

export interface Capacity {
  state: CapacityState;
  freeMb: number;
  totalMb: number;
  minMb: number;
  /** Coarse state word. Changes only when the state changes, which makes it the
   *  only part safe to put inside a live region on a polled value. */
  status: string;
  /** The moving number, rendered next to `status` but never announced. */
  figure: string | null;
  /** One sentence of context under the headline. */
  detail: string;
  /** Non-null when an Ubuntu GPU session cannot be spawned right now. This is
   *  the same rule /api/session/spawn preflights, so the button is disabled
   *  instead of dropping the user into a 503. */
  sessionBlocked: string | null;
}

/**
 * Reads capacity straight off /api/health. "Node offline" and "no VRAM to give"
 * are deliberately different states — one means come back later, the other means
 * the box that runs sessions is not reporting in at all.
 */
export function readCapacity(h: Health | null): Capacity {
  const freeMb = Number(h?.gpuVramFreeMb);
  const totalMb = Number(h?.gpuVramTotalMb);
  const minMb = Number(h?.minFreeVramMb);
  const known =
    !!h && typeof h.sessionNodeOnline === 'boolean' && Number.isFinite(freeMb) && Number.isFinite(minMb);
  const base = {
    freeMb: Number.isFinite(freeMb) ? freeMb : 0,
    totalMb: Number.isFinite(totalMb) ? totalMb : 0,
    minMb: Number.isFinite(minMb) ? minMb : 0,
  };
  const node = h?.sessionNode || 'the GPU node';

  if (!known) {
    return {
      ...base, state: 'unknown',
      status: 'Checking GPU capacity…', figure: null,
      detail: 'Reading live VRAM from the session node.',
      sessionBlocked: null,
    };
  }
  if (!h!.sessionNodeOnline) {
    return {
      ...base, state: 'offline',
      status: 'GPU node offline', figure: null,
      detail: `${node} is not reporting in, so no new sessions can start.`,
      sessionBlocked: `GPU node offline — ${node} is not reporting in`,
    };
  }
  if (base.minMb > 0 && base.freeMb < base.minMb) {
    return {
      ...base, state: 'busy',
      status: 'GPU busy', figure: `${Math.round(base.freeMb)} MiB free`,
      detail: `Another workload holds the card. A session needs ${Math.round(base.minMb)} MiB free; this usually clears in a moment.`,
      sessionBlocked: `GPU busy — ${Math.round(base.freeMb)} MiB free, needs ${Math.round(base.minMb)} MiB`,
    };
  }
  return {
    ...base, state: 'ready',
    status: 'GPU online', figure: `${fmtVram(base.freeMb)} VRAM free`,
    detail: base.totalMb > 0
      ? `Free right now on ${node}, out of ${fmtVram(base.totalMb)} total. The card is shared, so this moves.`
      : `Free right now on ${node}. The card is shared, so this moves.`,
    sessionBlocked: null,
  };
}

/** Public, unauthenticated status. Drives the landing page's and the guide's
 *  real numbers — every figure they print is one of these fields. */
export function useHealth(): Health | null {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/health');
        if (!r.ok) return;
        const d = await r.json();
        if (alive) setHealth(d);
      } catch { /* offline: the UI just falls back to static copy */ }
    };
    load();
    const t = window.setInterval(load, 30_000);
    return () => { alive = false; window.clearInterval(t); };
  }, []);
  return health;
}
