import type { Health } from './health';
import type { ACCENTS } from './components/ui';

/**
 * The five-tier product catalog.
 *
 * Honesty rules (see CLAUDE.md): every price and label a user sees must come
 * from `GET /api/health` at render time. The gateway exposes the catalog as a
 * `catalog` array of `{ tier, label, priceUsdPerHour, kind }`. When it wins, it
 * wins — its label and price override anything hardcoded here.
 *
 * Until the gateway ships that field, we degrade to FALLBACK_CATALOG below: the
 * same five tiers, so the storefront still renders rather than showing an empty
 * shelf. This is a fallback of last resort, NOT a source of truth — the moment
 * `health.catalog` is present it replaces every figure here.
 *
 * What is NOT in the catalog payload — the icon, the accent colour, the copy,
 * how you connect, and whether the GPU is attached — is presentation and is
 * derived here per tier. Only the `gpu` tier is GPU-attached, and its card is a
 * shared RTX 4080; every other tier is CPU/RAM only.
 */

/** The provisioning `kind` the gateway tags each tier with. `gpu` spawns an
 *  in-browser session; `qm` and `pct` are both KVM/CT provisions over
 *  /api/vms/provision. We route on this, never on the tier id, so an unknown
 *  tier from a newer gateway still lands on the right endpoint. */
export type TierKind = 'pct' | 'qm' | 'gpu';

/** One entry exactly as the gateway sends it on `/api/health`. */
export interface CatalogEntry {
  tier: string;
  label: string;
  priceUsdPerHour: number;
  kind: TierKind;
}

export type ConnectVia = 'SSH' | 'RDP' | 'In-browser';

/** A catalog entry merged with its presentation — what a deploy card renders. */
export interface TierCard extends CatalogEntry {
  accent: keyof typeof ACCENTS;
  iconKey: 'terminal' | 'laptop' | 'server' | 'monitor';
  connectVia: ConnectVia;
  gpuAttached: boolean;
  blurb: string;
  /** How to deploy this tier. `session` -> POST /api/session/spawn;
   *  `vm` -> POST /api/vms/provision with a `tier` field. */
  provision: 'session' | 'vm';
}

/** Presentation, keyed by tier id. Not from the API — icon/colour/copy/connect
 *  method are ours to choose; label and price always come from the catalog. */
type Presentation = Pick<
  TierCard, 'accent' | 'iconKey' | 'connectVia' | 'gpuAttached' | 'blurb'
>;

const PRESENTATION: Record<string, Presentation> = {
  'ubuntu-ct': {
    accent: 'violet',
    iconKey: 'server',
    connectVia: 'SSH',
    gpuAttached: false,
    blurb:
      'A headless Ubuntu container over SSH — no desktop, the lightest and cheapest way to get a root shell. CPU and RAM only.',
  },
  'linux-vm': {
    accent: 'violet',
    iconKey: 'server',
    connectVia: 'SSH',
    gpuAttached: false,
    blurb:
      'A full Ubuntu Linux VM over SSH with root. Docker and long-running server jobs on a real kernel. CPU and RAM only, no GPU attached.',
  },
  gpu: {
    accent: 'emerald',
    iconKey: 'terminal',
    connectVia: 'In-browser',
    gpuAttached: true,
    blurb:
      'A full Ubuntu desktop streamed to your browser over noVNC, with an RTX 4080 attached. The card is shared, so check the VRAM headroom above before a heavy run.',
  },
  win11: {
    accent: 'cyan',
    iconKey: 'laptop',
    connectVia: 'RDP',
    gpuAttached: false,
    blurb:
      'A real Windows 11 desktop over RDP with administrator access. GUI apps and general compute — CPU and RAM only, no GPU attached.',
  },
  comando: {
    accent: 'cyan',
    iconKey: 'monitor',
    connectVia: 'RDP',
    gpuAttached: false,
    blurb:
      'A premium, fully loaded Windows desktop over RDP — the top tier for heavier GUI workloads. CPU and RAM only, no GPU attached.',
  },
};

/** Last-resort copy of the catalog for when the gateway has not shipped the
 *  field yet. Mirrors the operator's price table exactly. */
export const FALLBACK_CATALOG: CatalogEntry[] = [
  { tier: 'ubuntu-ct', label: 'Ubuntu (headless CT)', priceUsdPerHour: 1, kind: 'pct' },
  { tier: 'linux-vm', label: 'Ubuntu Linux VM', priceUsdPerHour: 2, kind: 'qm' },
  { tier: 'gpu', label: 'GPU Session', priceUsdPerHour: 5, kind: 'gpu' },
  { tier: 'win11', label: 'Windows 11', priceUsdPerHour: 10, kind: 'qm' },
  { tier: 'comando', label: 'Comando VM', priceUsdPerHour: 20, kind: 'qm' },
];

/** Presentation for a tier the gateway names that we have no entry for — a
 *  newer gateway could add one. We still render it honestly: GPU-attached only
 *  when the kind says so, and connection method inferred from the kind. */
function fallbackPresentation(entry: CatalogEntry): Presentation {
  const isGpu = entry.kind === 'gpu';
  return {
    accent: isGpu ? 'emerald' : 'cyan',
    iconKey: isGpu ? 'terminal' : 'server',
    connectVia: isGpu ? 'In-browser' : 'SSH',
    gpuAttached: isGpu,
    blurb: isGpu
      ? 'An in-browser GPU desktop.'
      : 'A rented compute instance. CPU and RAM only, no GPU attached.',
  };
}

/** Is this a usable catalog entry from the wire? Guards against a malformed
 *  payload so one bad row cannot blank the storefront. */
function isEntry(x: unknown): x is CatalogEntry {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.tier === 'string' && e.tier.length > 0 &&
    typeof e.label === 'string' && e.label.length > 0 &&
    typeof e.priceUsdPerHour === 'number' && Number.isFinite(e.priceUsdPerHour) &&
    (e.kind === 'pct' || e.kind === 'qm' || e.kind === 'gpu')
  );
}

/**
 * The catalog to render, cheapest tier first. Reads `health.catalog` when the
 * gateway sends a usable one; otherwise falls back to the hardcoded table so
 * the page still renders. When present, the wire catalog wins outright — its
 * labels and prices, not ours.
 */
export function readCatalog(health: Health | null): TierCard[] {
  const wire = health?.catalog;
  const entries: CatalogEntry[] =
    Array.isArray(wire) && wire.filter(isEntry).length > 0
      ? (wire.filter(isEntry) as CatalogEntry[])
      : FALLBACK_CATALOG;

  return entries
    .map((e) => {
      const p = PRESENTATION[e.tier] ?? fallbackPresentation(e);
      return {
        ...e,
        ...p,
        // Route by kind, never by id: a gpu-kind tier spawns a session, every
        // other kind provisions a VM/CT.
        provision: e.kind === 'gpu' ? 'session' : 'vm',
      } as TierCard;
    })
    .sort((a, b) => a.priceUsdPerHour - b.priceUsdPerHour);
}

/** The advertised price range across the catalog, e.g. "from $1/hr". Landing
 *  copy uses this instead of a single hardcoded price. */
export function catalogRange(cards: TierCard[]): { min: number; max: number } | null {
  if (!cards.length) return null;
  const prices = cards.map((c) => c.priceUsdPerHour);
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

/** Resolve the tier a dashboard machine row belongs to, for its label and
 *  per-hour price. The gateway is adding `tier` (and may add a label/price) to
 *  vm and session rows; we read them defensively and fall back to the catalog.
 *  Returns null when there is nothing truthful to show — the caller then keeps
 *  its existing os-derived label and shows no fabricated price. */
export function resolveRowTier(
  row: { tier?: string | null; tier_label?: string | null; price_per_hour?: number | null },
  cards: TierCard[],
): { label: string; price: number | null } | null {
  const tier = typeof row.tier === 'string' ? row.tier : null;
  if (!tier) return null;
  const card = cards.find((c) => c.tier === tier);
  // Prefer a label/price the row carries; otherwise borrow the catalog's.
  const label =
    (typeof row.tier_label === 'string' && row.tier_label) || card?.label || tier;
  const price =
    typeof row.price_per_hour === 'number' && Number.isFinite(row.price_per_hour)
      ? row.price_per_hour
      : card
        ? card.priceUsdPerHour
        : null;
  return { label, price };
}
