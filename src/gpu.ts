import { fmtVram } from './health';

/**
 * Live GPU status, proxied by the gateway from HyperSwap's real telemetry.
 *
 * Honesty rules (see CLAUDE.md): every number rendered off this model is a real
 * reading taken at poll time. Nothing here invents a figure — when the gateway
 * cannot report a value it becomes `null` and the UI says "unknown" rather than
 * printing a plausible-looking number. This is the module that keeps the old
 * fake "GPU LOAD: 74%" from ever coming back: a value shows only when the wire
 * actually carried it.
 *
 * The whole payload is treated as optional. The backend ships `/api/gpu-status`
 * concurrently, so any field — or the entire endpoint — may be absent; the
 * derived model then degrades to `source: 'unknown'` and the caller falls back
 * to the /api/health capacity copy.
 */

/** The wire shape of `GET /api/gpu-status`. Every field optional on purpose —
 *  see the module note. */
export interface GpuStatusWire {
  source?: 'hyperswap' | 'unavailable' | string;
  busyPct?: number;
  vramUsedGb?: number;
  vramFreeGb?: number;
  vramTotalGb?: number;
  tempC?: number;
  holder?: string | null;
  activeJob?: { model?: string; elapsedS?: number; etaS?: number | null } | null;
  queueDepth?: number;
  etaSeconds?: number | null;
  available?: boolean;
}

/** A finite number, or null. The single coercion every field goes through so a
 *  string, NaN, Infinity or missing value can never reach the UI as a figure. */
function num(x: unknown): number | null {
  // null/undefined/'' must NOT coerce to 0 — an absent ETA has to stay null so
  // the countdown reads "time unknown" instead of a fabricated "00:00".
  if (x == null || x === '') return null;
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) ? n : null;
}

/** Clamp a percentage into 0–100; null stays null. */
function pct(x: unknown): number | null {
  const n = num(x);
  return n == null ? null : Math.min(100, Math.max(0, n));
}

export type GpuSource = 'hyperswap' | 'unavailable' | 'unknown';

export interface GpuStatus {
  /** True only when we have a real reading to render a meter from. False when
   *  the endpoint/fields were absent (source 'unknown') or HyperSwap is down
   *  (source 'unavailable'). */
  known: boolean;
  source: GpuSource;
  busyPct: number | null;
  vramUsedGb: number | null;
  vramFreeGb: number | null;
  vramTotalGb: number | null;
  tempC: number | null;
  holder: string | null;
  activeJob: { model: string; elapsedS: number | null; etaS: number | null } | null;
  queueDepth: number | null;
  etaSeconds: number | null;
  /** null when the wire did not say whether a session can start right now. */
  available: boolean | null;
}

/**
 * Normalise the raw `/api/gpu-status` payload into a model the UI can trust.
 *
 * - `null`/garbage/absent endpoint  -> source 'unknown', known false.
 * - `source: 'unavailable'`         -> HyperSwap is down; known false, numbers
 *                                       dropped so nothing renders as a reading.
 * - a real HyperSwap reading        -> known true, each field coerced to a
 *                                       finite number or null.
 */
export function readGpuStatus(raw: GpuStatusWire | null | undefined): GpuStatus {
  const EMPTY: GpuStatus = {
    known: false, source: 'unknown',
    busyPct: null, vramUsedGb: null, vramFreeGb: null, vramTotalGb: null,
    tempC: null, holder: null, activeJob: null, queueDepth: null,
    etaSeconds: null, available: null,
  };
  if (!raw || typeof raw !== 'object') return EMPTY;

  if (raw.source === 'unavailable') {
    // HyperSwap is not reporting. Do NOT surface stale/zero numbers as if they
    // were a live reading — the card shows "GPU status unavailable" instead.
    return { ...EMPTY, source: 'unavailable' };
  }

  const source: GpuSource = raw.source === 'hyperswap' ? 'hyperswap' : 'unknown';
  const busyPct = pct(raw.busyPct);
  const vramUsedGb = num(raw.vramUsedGb);
  const vramFreeGb = num(raw.vramFreeGb);
  const vramTotalGb = num(raw.vramTotalGb);
  const tempC = num(raw.tempC);
  const holder = typeof raw.holder === 'string' && raw.holder.trim() ? raw.holder.trim() : null;
  const queueDepth = num(raw.queueDepth);
  const etaSeconds = num(raw.etaSeconds); // null when the gateway can't estimate
  const available = typeof raw.available === 'boolean' ? raw.available : null;

  const aj = raw.activeJob;
  const activeJob =
    aj && typeof aj === 'object' && typeof aj.model === 'string' && aj.model.trim()
      ? { model: aj.model.trim(), elapsedS: num(aj.elapsedS), etaS: num(aj.etaS) }
      : null;

  // "known" means we have at least one real reading worth drawing a meter or a
  // figure from. A bare `{}` or a payload with no usable numbers stays unknown.
  const known =
    source === 'hyperswap' ||
    busyPct != null || vramFreeGb != null || vramTotalGb != null ||
    tempC != null || available != null;

  return {
    known, source,
    busyPct, vramUsedGb, vramFreeGb, vramTotalGb, tempC,
    holder, activeJob, queueDepth, etaSeconds, available,
  };
}

/** GiB label for a GB reading, reusing the health formatter so a GPU figure is
 *  rounded exactly like a VRAM figure everywhere else. */
export function fmtGb(gb: number | null | undefined): string {
  return gb == null || !Number.isFinite(gb) ? 'unknown' : fmtVram(gb * 1024);
}

/**
 * mm:ss for a countdown, or the honest words when there is no estimate.
 *
 * `null`/non-finite -> "waiting — time unknown" (never a fabricated number).
 * Otherwise MM:SS, floored, clamped at 00:00 — minutes are not capped at 59 so
 * a long wait still reads truthfully (e.g. "72:30").
 */
export function fmtCountdown(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return 'waiting — time unknown';
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/**
 * Seconds still to wait, ticking down locally between polls and re-synced on
 * each poll. `eta` was the estimate at `syncedAt`; `now` is the live clock, so
 * the remainder decreases every render without a second timer. Returns null
 * when there is no estimate — the caller then shows "time unknown".
 */
export function remainingSeconds(
  eta: number | null | undefined,
  syncedAt: number,
  now: number,
): number | null {
  if (eta == null || !Number.isFinite(eta)) return null;
  const elapsed = Math.max(0, (now - syncedAt) / 1000);
  return Math.max(0, eta - elapsed);
}

export type GpuDeployMode = 'ready' | 'queue' | 'unknown';

export interface GpuDeploy {
  mode: GpuDeployMode;
  /** How many jobs are ahead, when known. */
  queueDepth: number | null;
  etaSeconds: number | null;
  holder: string | null;
  /** Coarse, screen-reader-safe sentence. Changes only when the *mode* changes,
   *  so it is the only part safe to announce on a polled value. */
  announce: string;
}

/**
 * Turn a live status into how the GPU deploy control should behave.
 *
 * - available === true            -> 'ready': spawn starts immediately.
 * - available === false           -> 'queue': deploying joins the queue; the
 *                                     button shows the ETA + position, never a
 *                                     dead "GPU busy".
 * - unknown (endpoint/field gone) -> 'unknown': the caller falls back to the
 *                                     /api/health VRAM preflight copy.
 */
export function readGpuDeploy(gpu: GpuStatus): GpuDeploy {
  if (!gpu.known || gpu.available == null) {
    return { mode: 'unknown', queueDepth: null, etaSeconds: null, holder: null, announce: '' };
  }
  if (gpu.available) {
    return {
      mode: 'ready', queueDepth: gpu.queueDepth, etaSeconds: null, holder: gpu.holder,
      announce: 'A GPU session can start now.',
    };
  }
  const ahead = gpu.queueDepth != null && gpu.queueDepth > 0
    ? `${gpu.queueDepth} ahead of you`
    : 'you are next';
  return {
    mode: 'queue', queueDepth: gpu.queueDepth, etaSeconds: gpu.etaSeconds, holder: gpu.holder,
    announce: `The GPU is busy — deploying now joins the queue, ${ahead}.`,
  };
}

/** "N ahead of you" / "you are next" / null when the depth is unknown. */
export function queueLabel(queueDepth: number | null): string | null {
  if (queueDepth == null) return null;
  return queueDepth > 0 ? `${queueDepth} ahead of you` : 'you are next';
}
