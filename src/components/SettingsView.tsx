import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight, Bitcoin, CheckCircle2, ExternalLink, Eye, EyeOff, KeyRound,
  Lock, LogOut, Receipt, ShieldAlert, User as UserIcon,
} from 'lucide-react';
import {
  Alert, BTN_BASE, BTN_DANGER, BTN_GHOST, BTN_PRIMARY, ConfirmDialog, CopyField,
  INPUT_CLS, Spinner, cx, readError,
} from './ui';

/**
 * Settings — account, security and billing.
 *
 * Backed only by endpoints that actually exist in server.ts:
 *   GET  /api/account                  { user }
 *   POST /api/auth/change-password     { currentPassword, newPassword }
 *   POST /api/auth/logout-all          revokes every token, this one included
 *   GET  /api/invoices                 { invoices[] }
 * Nothing here is mocked; anything the API does not return is simply not shown.
 */

export interface AccountUser {
  id: string;
  username: string;
  balance_minutes: number;
  unlimited?: boolean;
  btc_address?: string | null;
  created_at?: number | string | null;
}

export interface Invoice {
  id: string;
  amount_usd: number;
  minutes: number;
  status: string;
  checkout_link?: string | null;
  created_at?: number | string | null;
  settled_at?: number | string | null;
}

/** Timestamps come back as epoch ms, epoch seconds or an ISO string
 *  depending on the row; render whichever of those parses, never "NaN". */
function fmtDate(value: number | string | null | undefined, withTime = false): string {
  if (value === null || value === undefined || value === '') return '—';
  let ms: number;
  if (typeof value === 'number') {
    ms = value < 1e12 ? value * 1000 : value;
  } else {
    const asNum = Number(value);
    ms = Number.isFinite(asNum) && value.trim() !== '' ? (asNum < 1e12 ? asNum * 1000 : asNum) : Date.parse(value);
  }
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return withTime
    ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

const SETTLED = /^(settled|paid|complete|completed|confirmed|credited)$/i;
const PENDING = /^(new|pending|processing|unpaid|waiting)$/i;

function InvoiceStatus({ status }: { status: string }) {
  const cls = SETTLED.test(status)
    ? 'bg-emerald-400/15 text-emerald-300 ring-emerald-400/30'
    : PENDING.test(status)
      ? 'bg-amber-400/15 text-amber-300 ring-amber-400/30'
      : 'bg-white/5 text-zinc-400 ring-white/10';
  return (
    <span className={cx('rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1', cls)}>
      {status || 'unknown'}
    </span>
  );
}

function SettingsSection({
  id, icon, title, sub, children,
}: {
  id: string; icon: React.ReactNode; title: string; sub: string; children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-h`} className="surface rounded-2xl p-5 sm:p-6">
      <div className="mb-5 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-cyan-400">
          {icon}
        </span>
        <div className="min-w-0">
          <h2 id={`${id}-h`} className="text-base font-bold tracking-tight text-zinc-100">{title}</h2>
          <p className="mt-0.5 text-xs text-zinc-500">{sub}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3">
      <dt className="text-[10px] font-medium uppercase tracking-widest text-zinc-500">{label}</dt>
      <dd className="mt-1 text-sm text-zinc-100">{children}</dd>
    </div>
  );
}

export function SettingsView({
  token, fallbackUser, onBack, onLoggedOutEverywhere,
}: {
  token: string;
  /** From /api/me — shown immediately so the page is never blank. */
  fallbackUser: { id: string; username: string; balance_minutes: number; unlimited?: boolean };
  onBack: () => void;
  onLoggedOutEverywhere: () => void;
}) {
  /* ---------------------------------------------------------- account */
  const [account, setAccount] = useState<AccountUser | null>(null);
  const [accountErr, setAccountErr] = useState('');
  const [accountLoading, setAccountLoading] = useState(true);

  const loadAccount = useCallback(async () => {
    setAccountLoading(true);
    setAccountErr('');
    try {
      const r = await fetch('/api/account', { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) { setAccountErr(await readError(r, 'Could not load your account')); return; }
      const d = await r.json();
      if (d?.user) setAccount(d.user);
      else setAccountErr('The server returned no account details.');
    } catch {
      setAccountErr('Network error — could not reach the gateway.');
    } finally {
      setAccountLoading(false);
    }
  }, [token]);

  /* --------------------------------------------------------- invoices */
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [invoicesErr, setInvoicesErr] = useState('');
  const [invoicesLoading, setInvoicesLoading] = useState(true);

  const loadInvoices = useCallback(async () => {
    setInvoicesLoading(true);
    setInvoicesErr('');
    try {
      const r = await fetch('/api/invoices', { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) { setInvoicesErr(await readError(r, 'Could not load your invoices')); return; }
      const d = await r.json();
      setInvoices(Array.isArray(d?.invoices) ? d.invoices : []);
    } catch {
      setInvoicesErr('Network error — could not reach the gateway.');
    } finally {
      setInvoicesLoading(false);
    }
  }, [token]);

  useEffect(() => { loadAccount(); loadInvoices(); }, [loadAccount, loadInvoices]);

  /* -------------------------------------------------- change password */
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState('');
  const [pwDone, setPwDone] = useState(false);

  // Mirrors the server's rule so nobody round-trips for a length check.
  const newPwOk = newPw.length >= 6;
  const matchOk = confirmPw.length > 0 && confirmPw === newPw;
  const canSubmitPw = currentPw.length > 0 && newPwOk && matchOk && !pwBusy;

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmitPw) return;
    setPwBusy(true);
    setPwError('');
    setPwDone(false);
    try {
      const r = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      });
      if (!r.ok) { setPwError(await readError(r, 'Could not change your password')); return; }
      setPwDone(true);
      setCurrentPw(''); setNewPw(''); setConfirmPw('');
    } catch {
      setPwError('Network error — could not reach the gateway.');
    } finally {
      setPwBusy(false);
    }
  };

  /* ------------------------------------------------------ logout all */
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState('');

  const logoutEverywhere = async () => {
    setLogoutBusy(true);
    setLogoutError('');
    try {
      const r = await fetch('/api/auth/logout-all', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) { setLogoutError(await readError(r, 'Could not revoke your sessions')); return; }
      // This token is revoked too, so there is nothing left to stay signed in with.
      onLoggedOutEverywhere();
    } catch {
      setLogoutError('Network error — could not reach the gateway.');
    } finally {
      setLogoutBusy(false);
    }
  };

  const shownUser = account ?? fallbackUser;
  const btcAddress = account?.btc_address ?? '';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Settings</h1>
          <p className="mt-1 text-xs text-zinc-500">Account details, security and billing history.</p>
        </div>
        <button type="button" onClick={onBack} className={cx(BTN_GHOST, 'px-4 py-2 text-sm')}>
          <ArrowRight className="w-4 h-4 rotate-180" aria-hidden="true" /> Back to console
        </button>
      </div>

      {/* ---------------------------------------------------- Account ---- */}
      <SettingsSection
        id="account"
        icon={<UserIcon className="w-4 h-4" aria-hidden="true" />}
        title="Account"
        sub="Anonymous by design — there is no email on file."
      >
        <div aria-live="polite">
          {accountErr && (
            <div className="mb-4">
              <Alert
                onDismiss={() => setAccountErr('')}
                action={
                  <button type="button" onClick={loadAccount} className={cx(BTN_GHOST, 'px-3 py-1.5 text-xs')}>
                    Retry
                  </button>
                }
              >
                {accountErr}
              </Alert>
            </div>
          )}
        </div>

        {accountLoading && !account ? (
          <div className="grid gap-3 sm:grid-cols-2" aria-busy="true">
            <span className="sr-only">Loading your account</span>
            <div className="skeleton h-[4.5rem] rounded-xl" />
            <div className="skeleton h-[4.5rem] rounded-xl" />
            <div className="skeleton h-[4.5rem] rounded-xl sm:col-span-2" />
          </div>
        ) : (
          <dl className="grid gap-3 sm:grid-cols-2">
            <Field label="Username">
              <span className="font-mono text-cyan-300">@{shownUser.username}</span>
              {shownUser.unlimited && (
                <span className="ml-2 text-amber-400" title="Unlimited account">∞ unlimited</span>
              )}
            </Field>
            <Field label="Member since">
              {account ? fmtDate(account.created_at) : '—'}
            </Field>
            <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 sm:col-span-2">
              <dt className="text-[10px] font-medium uppercase tracking-widest text-zinc-500">
                Bitcoin address
              </dt>
              <dd className="mt-2">
                {btcAddress ? (
                  <CopyField label="btc" value={btcAddress} />
                ) : (
                  <p className="flex items-center gap-2 text-xs text-zinc-500">
                    <Bitcoin className="w-3.5 h-3.5 text-amber-400/70" aria-hidden="true" />
                    No Bitcoin address on file for this account.
                  </p>
                )}
              </dd>
            </div>
          </dl>
        )}
      </SettingsSection>

      {/* --------------------------------------------------- Security ---- */}
      <SettingsSection
        id="security"
        icon={<Lock className="w-4 h-4" aria-hidden="true" />}
        title="Security"
        sub="Passwords cannot be recovered by email — store the new one safely."
      >
        <form onSubmit={changePassword} noValidate className="space-y-4">
          <div>
            <label htmlFor="current-password" className="mb-1.5 block text-xs font-medium uppercase tracking-widest text-zinc-500">
              Current password
            </label>
            <input
              id="current-password"
              name="current-password"
              type={showPw ? 'text' : 'password'}
              value={currentPw}
              onChange={(e) => { setCurrentPw(e.target.value); setPwDone(false); }}
              autoComplete="current-password"
              required
              className={INPUT_CLS}
            />
          </div>

          <div>
            <label htmlFor="new-password" className="mb-1.5 block text-xs font-medium uppercase tracking-widest text-zinc-500">
              New password
            </label>
            <div className="relative">
              <input
                id="new-password"
                name="new-password"
                type={showPw ? 'text' : 'password'}
                value={newPw}
                onChange={(e) => { setNewPw(e.target.value); setPwDone(false); }}
                autoComplete="new-password"
                required
                aria-describedby="new-password-hint"
                aria-invalid={newPw.length > 0 && !newPwOk}
                className={cx(INPUT_CLS, 'pr-12')}
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? 'Hide passwords' : 'Show passwords'}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-zinc-500 hover:text-white"
              >
                {showPw ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
              </button>
            </div>
            <p
              id="new-password-hint"
              className={cx('mt-1.5 text-[11px]', newPw.length > 0 && !newPwOk ? 'text-amber-400' : 'text-zinc-600')}
            >
              Minimum 6 characters. There is no email recovery.
            </p>
          </div>

          <div>
            <label htmlFor="confirm-password" className="mb-1.5 block text-xs font-medium uppercase tracking-widest text-zinc-500">
              Confirm new password
            </label>
            <input
              id="confirm-password"
              name="confirm-password"
              type={showPw ? 'text' : 'password'}
              value={confirmPw}
              onChange={(e) => { setConfirmPw(e.target.value); setPwDone(false); }}
              autoComplete="new-password"
              required
              aria-describedby="confirm-password-hint"
              aria-invalid={confirmPw.length > 0 && !matchOk}
              className={INPUT_CLS}
            />
            <p
              id="confirm-password-hint"
              className={cx('mt-1.5 text-[11px]', confirmPw.length > 0 && !matchOk ? 'text-amber-400' : 'text-zinc-600')}
            >
              {confirmPw.length > 0 && !matchOk ? 'The two passwords do not match.' : 'Type the new password again.'}
            </p>
          </div>

          <div aria-live="assertive" className="space-y-3 empty:hidden">
            {pwError && <Alert onDismiss={() => setPwError('')}>{pwError}</Alert>}
            {pwDone && (
              <div className="flex items-center gap-2 rounded-xl border border-emerald-400/40 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-200">
                <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                Password changed. Every other device was signed out; this one stays signed in.
              </div>
            )}
          </div>

          <button type="submit" disabled={!canSubmitPw} aria-busy={pwBusy} className={cx(BTN_PRIMARY, 'w-full py-3 text-sm sm:w-auto sm:px-6')}>
            {pwBusy ? <><Spinner /> Updating…</> : <><KeyRound className="w-4 h-4" aria-hidden="true" /> Change password</>}
          </button>
        </form>

        <div className="mt-6 border-t border-white/10 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-[14rem] flex-1">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                <ShieldAlert className="w-4 h-4 text-red-400" aria-hidden="true" /> Log out everywhere
              </h3>
              <p className="mt-1 text-xs text-zinc-500">
                Revokes every access token, including the one on this device. You will be signed back out to the login screen.
              </p>
            </div>
            <button type="button" onClick={() => { setLogoutError(''); setLogoutOpen(true); }} className={cx(BTN_DANGER, 'px-4 py-2.5 text-xs')}>
              <LogOut className="w-4 h-4" aria-hidden="true" /> Log out everywhere
            </button>
          </div>
        </div>
      </SettingsSection>

      {/* ---------------------------------------------------- Billing ---- */}
      <SettingsSection
        id="billing"
        icon={<Receipt className="w-4 h-4" aria-hidden="true" />}
        title="Billing"
        sub="Every Bitcoin invoice raised on this account."
      >
        <div aria-live="polite">
          {invoicesErr && (
            <div className="mb-4">
              <Alert
                onDismiss={() => setInvoicesErr('')}
                action={
                  <button type="button" onClick={loadInvoices} className={cx(BTN_GHOST, 'px-3 py-1.5 text-xs')}>
                    Retry
                  </button>
                }
              >
                {invoicesErr}
              </Alert>
            </div>
          )}
        </div>

        {invoicesLoading && invoices === null ? (
          <div className="space-y-2" aria-busy="true">
            <span className="sr-only">Loading your invoices</span>
            <div className="skeleton h-11 rounded-xl" />
            <div className="skeleton h-11 rounded-xl" />
            <div className="skeleton h-11 rounded-xl" />
          </div>
        ) : invoices && invoices.length === 0 ? (
          <div className="rounded-xl border border-white/10 bg-black/20 px-6 py-12 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
              <Bitcoin className="w-5 h-5 text-amber-400" aria-hidden="true" />
            </div>
            <h3 className="text-sm font-semibold text-zinc-100">No invoices yet</h3>
            <p className="mx-auto mt-2 max-w-sm text-xs text-zinc-500">
              Buying GPU minutes from the console creates a Bitcoin invoice, and it will show up here with its status.
            </p>
          </div>
        ) : invoices ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
              <caption className="sr-only">Invoice history</caption>
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-zinc-500">
                  <th scope="col" className="border-b border-white/10 pb-2 pr-3 font-medium">Amount</th>
                  <th scope="col" className="border-b border-white/10 pb-2 pr-3 font-medium">Minutes</th>
                  <th scope="col" className="border-b border-white/10 pb-2 pr-3 font-medium">Status</th>
                  <th scope="col" className="border-b border-white/10 pb-2 pr-3 font-medium">Created</th>
                  <th scope="col" className="border-b border-white/10 pb-2 font-medium">
                    <span className="sr-only">Checkout</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => {
                  const pending = PENDING.test(inv.status) && !!inv.checkout_link;
                  return (
                    <tr key={inv.id} className="border-b border-white/5 last:border-0">
                      <td className="py-3 pr-3 font-mono text-amber-300">
                        ${Number(inv.amount_usd ?? 0).toFixed(2)}
                      </td>
                      <td className="py-3 pr-3 font-mono text-zinc-200">{inv.minutes ?? 0}</td>
                      <td className="py-3 pr-3"><InvoiceStatus status={inv.status} /></td>
                      <td className="py-3 pr-3 whitespace-nowrap text-xs text-zinc-400">
                        {fmtDate(inv.created_at, true)}
                        {inv.settled_at && (
                          <span className="block text-[10px] text-emerald-400/80">
                            settled {fmtDate(inv.settled_at)}
                          </span>
                        )}
                      </td>
                      <td className="py-3 text-right">
                        {pending && inv.checkout_link ? (
                          <a
                            href={inv.checkout_link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={cx(BTN_BASE, 'border border-amber-400/40 px-3 py-1.5 text-[11px] text-amber-300 hover:bg-amber-400/10')}
                          >
                            <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                            Pay
                            <span className="sr-only"> invoice of ${Number(inv.amount_usd ?? 0).toFixed(2)}</span>
                          </a>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </SettingsSection>

      {logoutOpen && (
        <ConfirmDialog
          title="Log out everywhere?"
          confirmLabel="Revoke all sessions"
          busyLabel="Revoking…"
          busy={logoutBusy}
          error={logoutError}
          icon={<ShieldAlert className="w-5 h-5 text-red-400" aria-hidden="true" />}
          onConfirm={logoutEverywhere}
          onClose={() => { if (!logoutBusy) setLogoutOpen(false); }}
        >
          <p>
            This revokes every access token on the account — phones, other browsers, and{' '}
            <strong className="text-zinc-200">this device too</strong>.
          </p>
          <p>You will land back on the sign-in screen and need your password to return.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
