import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle, CheckCircle2, Copy, Eye, EyeOff, KeyRound, Loader2, X,
} from 'lucide-react';

/**
 * Shared UI vocabulary for the console.
 *
 * These primitives were extracted out of App.tsx so the dashboard, the pay
 * modal and the settings area all render the *same* buttons, alerts, badges
 * and dialog chrome instead of drifting into two dialects.
 */

export const cx = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(' ');

/* Shared class recipes — one place to keep buttons consistent. */
export const BTN_BASE =
  'inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors ' +
  'disabled:opacity-45 disabled:cursor-not-allowed select-none';
export const BTN_PRIMARY = `${BTN_BASE} bg-cyan-400 text-ink-950 hover:bg-cyan-300 disabled:hover:bg-cyan-400`;
export const BTN_AMBER = `${BTN_BASE} bg-amber-400 text-ink-950 hover:bg-amber-300 disabled:hover:bg-amber-400`;
export const BTN_GHOST = `${BTN_BASE} border border-white/15 text-zinc-200 hover:border-cyan-400/50 hover:text-white`;
export const BTN_DANGER = `${BTN_BASE} border border-red-500/40 text-red-300 hover:bg-red-500/10`;

/* Text inputs — same recipe the auth form uses. */
export const INPUT_CLS =
  'w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-zinc-100 ' +
  'placeholder:text-zinc-600 outline-none focus:border-cyan-400';

/** Server errors are `{ error }` JSON, but a proxy hiccup can return HTML.
 *  Rate-limited replies also carry `retryAfterSec`; "slow down" with no
 *  duration attached just leaves people refreshing blindly. */
export async function readError(r: Response, fallback: string): Promise<string> {
  try {
    const d = await r.json();
    if (d && typeof d.error === 'string' && d.error) {
      const wait = Number(d.retryAfterSec);
      if (r.status === 429 && Number.isFinite(wait) && wait > 0) {
        return `${d.error} — try again in ${wait < 90 ? `${Math.ceil(wait)}s` : `${Math.ceil(wait / 60)} min`}.`;
      }
      return d.error;
    }
  } catch { /* not JSON */ }
  return `${fallback} (HTTP ${r.status})`;
}

export function fmtBalance(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

export function Spinner({ className = 'w-4 h-4' }: { className?: string }) {
  return <Loader2 className={cx(className, 'animate-spin')} aria-hidden="true" />;
}

/** Inline, dismissible, announced to assistive tech. */
export function Alert({
  tone = 'error', children, onDismiss, action,
}: {
  tone?: 'error' | 'warn' | 'info';
  children: React.ReactNode;
  onDismiss?: () => void;
  action?: React.ReactNode;
}) {
  const tones = {
    error: 'border-red-500/40 bg-red-950/40 text-red-200',
    warn: 'border-amber-500/40 bg-amber-950/30 text-amber-200',
    info: 'border-cyan-500/40 bg-cyan-950/30 text-cyan-100',
  } as const;
  return (
    <div
      role="alert"
      className={cx('flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3 text-sm', tones[tone])}
    >
      <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span className="flex-1 min-w-[12rem]">{children}</span>
      {action}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss message"
          className="rounded-md p-1 hover:bg-white/10"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function StateBadge({ state }: { state: string }) {
  const cls =
    state === 'running' ? 'bg-emerald-400/15 text-emerald-300 ring-emerald-400/30'
      : state === 'provisioning' ? 'bg-amber-400/15 text-amber-300 ring-amber-400/30'
        : state === 'failed' ? 'bg-red-500/15 text-red-300 ring-red-500/30'
          : 'bg-white/5 text-zinc-400 ring-white/10';
  return (
    <span className={cx('rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1', cls)}>
      {state}
    </span>
  );
}

export function CopyField({
  label, value, secret = false,
}: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(!secret);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 font-mono text-[11px]">
      <KeyRound className="w-3.5 h-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
      <span className="text-zinc-500">{label}</span>
      <span className={cx('flex-1 truncate select-all', shown ? 'text-amber-300' : 'text-zinc-600')}>
        {shown ? value : '•'.repeat(Math.min(16, value.length))}
      </span>
      {secret && (
        <button
          type="button"
          onClick={() => setShown((v) => !v)}
          aria-label={shown ? `Hide ${label}` : `Show ${label}`}
          className="shrink-0 rounded p-0.5 text-zinc-400 hover:text-white"
        >
          {shown ? <EyeOff className="w-3.5 h-3.5" aria-hidden="true" /> : <Eye className="w-3.5 h-3.5" aria-hidden="true" />}
        </button>
      )}
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${label}`}
        className="flex shrink-0 items-center gap-1 rounded px-1 font-bold text-cyan-400 hover:text-cyan-300"
      >
        {copied
          ? <><CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" /> Copied</>
          : <><Copy className="w-3.5 h-3.5" aria-hidden="true" /> Copy</>}
      </button>
      <span aria-live="polite" className="sr-only">{copied ? `${label} copied to clipboard` : ''}</span>
    </div>
  );
}

/**
 * Dialog chrome shared by every modal: Escape closes, Tab is trapped inside,
 * the page behind stops scrolling, and focus returns where it came from.
 */
export function useDialogChrome(
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button, [href], input, select, textarea')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab' || !ref.current) return;
      const all: HTMLElement[] = [];
      ref.current
        .querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        .forEach((n) => all.push(n));
      const nodes = all.filter((n) => !n.hasAttribute('disabled'));
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [ref, onClose]);
}

/**
 * Irreversible actions get an explicit, keyboard-navigable confirmation —
 * never a bare window.confirm, which cannot be styled, trapped or announced.
 */
export function ConfirmDialog({
  title, confirmLabel, busyLabel, busy = false, error, icon, onConfirm, onClose, children,
}: {
  title: string;
  confirmLabel: string;
  busyLabel?: string;
  busy?: boolean;
  error?: string;
  icon?: React.ReactNode;
  onConfirm: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogChrome(dialogRef, onClose);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/80 p-4 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
        className="surface my-auto w-full max-w-md rounded-2xl border-red-500/30 p-6"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 id="confirm-title" className="flex items-center gap-2 text-lg font-bold">
            {icon ?? <AlertTriangle className="w-5 h-5 text-red-400" aria-hidden="true" />}
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close dialog"
            className="rounded-lg p-1.5 text-zinc-500 hover:bg-white/5 hover:text-white disabled:opacity-45"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div id="confirm-body" className="space-y-3 text-sm leading-relaxed text-zinc-400">
          {children}
        </div>

        <div aria-live="assertive" className="empty:hidden">
          {error && <div className="mt-4"><Alert>{error}</Alert></div>}
        </div>

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className={cx(BTN_GHOST, 'flex-1 py-2.5 text-sm')}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy}
            className={cx(BTN_BASE, 'flex-1 bg-red-500 py-2.5 text-sm text-white hover:bg-red-400 disabled:hover:bg-red-500')}
          >
            {busy ? <><Spinner /> {busyLabel ?? 'Working…'}</> : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
