import React from 'react';
import {
  ArrowRight, Bitcoin, CheckCircle2, ChevronRight, Cpu, ExternalLink, HelpCircle,
  Laptop, LifeBuoy, Monitor, Plug, Rocket, Server, Shield, Terminal, Wallet,
} from 'lucide-react';
import { ACCENTS, BTN_GHOST, BTN_PRIMARY, cx } from './ui';
import { rdpCommand, sshCommand } from '../connect';
import { type Health, fmtVram, readCapacity } from '../health';

/**
 * "How it works" — the user-facing guide.
 *
 * Ground rules for this file, learned the hard way: a previous build of this
 * page shipped a review score and a GPU load bar that nothing produced, and
 * both had to be torn out. So:
 *
 *   - Every number is read from `GET /api/health` at render time
 *     (priceUsdPerHour, freeMachines, maxVmsPerUser, gpuSku, minFreeVramMb,
 *     gpuVramFreeMb / gpuVramTotalMb, sessionNode, sessionNodeOnline).
 *     Nothing is hardcoded, and when health has not loaded the figure is "—".
 *   - No benchmarks, no testimonials, no uptime percentages, no ratings.
 *     If server.ts does not do it, this page does not claim it.
 *   - The command forms come from ../connect, the same functions the machine
 *     card renders a live machine with, so the documented form cannot drift
 *     from the emitted one.
 *
 * Behaviour described here is traceable to server.ts:
 *   POST /api/session/spawn      Ubuntu GPU session (Docker + Xvfb/noVNC, GPU attached)
 *   POST /api/vms/provision      KVM guest, os=windows (RDP) | os=linux (SSH)
 *   POST /api/vms/destroy        stop  (billing only counts state='running')
 *   POST /api/vms/delete         delete, 409 "stop the machine first" while live
 *   POST /api/btcpay/webhook     credits the balance on InvoiceSettled
 *   billing sweep                every 60s: max(0, running - FREE_MACHINES) minutes
 */

/* --------------------------------------------------------------- layout */

function GuideSection({
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

/** A shell command or address, shown in full. The container scrolls rather
 *  than the page — a long ssh line must not push the layout sideways on a
 *  narrow screen. */
function Cmd({ children }: { children: string }) {
  return (
    <pre className="mt-2 overflow-x-auto rounded-lg border border-white/10 bg-black/40 px-3 py-2">
      <code className="font-mono text-[11px] text-cyan-300">{children}</code>
    </pre>
  );
}

function Fact({ label, value, sub }: { label: string; value: React.ReactNode; sub: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/30 px-4 py-3">
      <dt className="text-[10px] font-medium uppercase tracking-widest text-zinc-500">{label}</dt>
      <dd className="mt-1 font-mono text-xl font-bold text-cyan-300">{value}</dd>
      <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">{sub}</p>
    </div>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-sm leading-relaxed text-zinc-400">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/* -------------------------------------------------------------- machines */

function MachineCard({
  icon, accent, name, tag, endpoint, gpu, children,
}: {
  icon: React.ReactNode; accent: keyof typeof ACCENTS; name: string; tag: string;
  endpoint: string; gpu: 'attached' | 'not-attached'; children: React.ReactNode;
}) {
  const a = ACCENTS[accent];
  return (
    <div className={cx('surface flex h-full flex-col rounded-xl p-4', a.ring)}>
      <div className={cx('mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/5', a.text)}>
        {icon}
      </div>
      <h3 className="font-semibold text-zinc-100">{name}</h3>
      <p className={cx('mt-0.5 text-[11px] font-medium uppercase tracking-wider', a.text)}>{tag}</p>
      <div className="mt-3 flex-1 space-y-2 text-sm leading-relaxed text-zinc-400">{children}</div>
      <p
        className={cx(
          'mt-4 inline-flex items-center gap-1.5 self-start rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1',
          gpu === 'attached'
            ? 'bg-emerald-400/15 text-emerald-300 ring-emerald-400/30'
            : 'bg-white/5 text-zinc-400 ring-white/10',
        )}
      >
        <Cpu className="h-3 w-3" aria-hidden="true" />
        {gpu === 'attached' ? 'GPU attached' : 'No GPU attached'}
      </p>
      <p className="mt-2 truncate font-mono text-[10px] text-zinc-600" title={endpoint}>{endpoint}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ FAQ */

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="group rounded-xl border border-white/10 bg-black/20 px-4 py-3">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-semibold text-zinc-100">
        <span className="min-w-0">{q}</span>
        <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500 transition-transform group-open:rotate-90" aria-hidden="true" />
      </summary>
      <div className="mt-3 space-y-2 text-sm leading-relaxed text-zinc-400">{children}</div>
    </details>
  );
}

/* ----------------------------------------------------------------- page */

export function GuideView({
  health, onBack, backLabel, onGetStarted,
}: {
  /** Live /api/health. Null until the first poll lands — every figure below
   *  falls back to "—" rather than to a plausible-looking constant. */
  health: Health | null;
  onBack: () => void;
  backLabel: string;
  /** Only passed for signed-out visitors; signed-in users are already in the
   *  console and do not need a "create an account" call to action. */
  onGetStarted?: () => void;
}) {
  const price = health?.priceUsdPerHour;
  const perHour = typeof price === 'number' && price > 0 ? price : null;
  const freeMachines = health?.freeMachines;
  const maxMachines = health?.maxVmsPerUser;
  const gpuSku = health?.gpuSku;
  const capacity = readCapacity(health);

  /* Wording that has to agree with a count the server owns — including the
   * verb, which changes with the count and with whether health has loaded. */
  const freeSubject = freeMachines === undefined
    ? 'Your free allowance of machines'
    : `Your first ${freeMachines} concurrent machine${freeMachines === 1 ? '' : 's'}`;
  const freeVerb = freeMachines === undefined || freeMachines === 1 ? 'is' : 'are';
  const dash = '—';

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight">How it works</h1>
          <p className="mt-1 text-xs text-zinc-500">
            What you can rent, what it costs, and how to connect. Every number on this page is read live from the gateway.
          </p>
        </div>
        <button type="button" onClick={onBack} className={cx(BTN_GHOST, 'px-4 py-2 text-sm')}>
          <ArrowRight className="h-4 w-4 rotate-180" aria-hidden="true" /> {backLabel}
        </button>
      </div>

      {/* ------------------------------------------------- live figures ---- */}
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Fact
          label="Price"
          value={perHour === null ? dash : `$${perHour}/hr`}
          sub="Per billed machine, charged by the minute."
        />
        <Fact
          label="Free machines"
          value={freeMachines === undefined ? dash : freeMachines}
          sub="Concurrent machines that are never billed."
        />
        <Fact
          label="Concurrent max"
          value={maxMachines === undefined ? dash : maxMachines}
          sub="Machines running at once, per account."
        />
        <Fact
          label="GPU VRAM free"
          value={
            capacity.state === 'unknown' ? dash
              : capacity.state === 'offline' ? 'Offline'
                : fmtVram(capacity.freeMb)
          }
          sub={gpuSku ? `On ${gpuSku}.` : 'Reading from the session node.'}
        />
      </dl>

      {/* ------------------------------------------------------ machines ---- */}
      <GuideSection
        id="machines"
        icon={<Monitor className="h-4 w-4" aria-hidden="true" />}
        title="What you get"
        sub="Three machine types. They are genuinely different — only one has the GPU."
      >
        <div className="grid gap-4 md:grid-cols-3">
          <MachineCard
            icon={<Terminal className="h-5 w-5" aria-hidden="true" />}
            accent="emerald"
            name="Ubuntu GPU session"
            tag="In-browser desktop"
            endpoint="POST /api/session/spawn"
            gpu="attached"
          >
            <p>
              A Docker container on the session node running an Ubuntu desktop on a virtual display (Xvfb), served to
              your browser over noVNC — with the GPU attached.
            </p>
            <p>
              You open it in a tab. There is no client to install and nothing to configure locally.
            </p>
          </MachineCard>

          <MachineCard
            icon={<Laptop className="h-5 w-5" aria-hidden="true" />}
            accent="cyan"
            name="Windows VM"
            tag="RDP · full KVM guest"
            endpoint="POST /api/vms/provision · os=windows"
            gpu="not-attached"
          >
            <p>
              A full Windows virtual machine, cloned from a template and reached over RDP on a port allocated to your
              machine alone.
            </p>
            <p>Plain compute: CPU, RAM and disk. The GPU is not passed through to it.</p>
          </MachineCard>

          <MachineCard
            icon={<Server className="h-5 w-5" aria-hidden="true" />}
            accent="violet"
            name="Linux VM"
            tag="SSH · full KVM guest"
            endpoint="POST /api/vms/provision · os=linux"
            gpu="not-attached"
          >
            <p>
              A full Linux virtual machine, reached over SSH on its own dedicated port. Headless — no desktop in the
              way.
            </p>
            <p>Plain compute, same as the Windows guest. The GPU is not passed through to it.</p>
          </MachineCard>
        </div>

        <p className="mt-4 flex items-start gap-2.5 rounded-xl border border-emerald-400/25 bg-emerald-400/5 px-4 py-3 text-sm leading-relaxed text-emerald-100">
          <Cpu className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden="true" />
          <span>
            <strong className="font-semibold">The Ubuntu session is the only GPU-attached machine.</strong>{' '}
            If you came here for the {gpuSku ? gpuSku : 'GPU'}, that is the one to spawn. The Windows and Linux VMs are
            ordinary compute instances.
          </span>
        </p>
      </GuideSection>

      {/* ------------------------------------------------------ benefits ---- */}
      <GuideSection
        id="why"
        icon={<Shield className="h-4 w-4" aria-hidden="true" />}
        title="What the account actually asks of you"
        sub="Stated plainly, including the parts that cut both ways."
      >
        <ul className="grid list-none gap-3 p-0 sm:grid-cols-2">
          <Bullet>
            <strong className="font-semibold text-zinc-200">No KYC, no personal details.</strong> Registration takes a
            username and a password. There is no email field on the account — which also means there is no password
            reset, so store it somewhere safe.
          </Bullet>
          <Bullet>
            <strong className="font-semibold text-zinc-200">Paid in Bitcoin.</strong> Top-ups are Bitcoin invoices
            raised through BTCPay. No card, no third-party processor.
          </Bullet>
          <Bullet>
            <strong className="font-semibold text-zinc-200">
              {freeMachines === undefined ? 'Your first machines are free.' : `The first ${freeMachines} machine${freeMachines === 1 ? ' is' : 's are'} free.`}
            </strong>{' '}
            You can try the service before you have paid anything at all.
          </Bullet>
          <Bullet>
            <strong className="font-semibold text-zinc-200">Billed by the minute.</strong>{' '}
            {perHour === null
              ? 'Beyond the free allowance, machines draw down your balance every minute they run.'
              : `Beyond the free allowance, each running machine costs the $${perHour}/hr rate, deducted a minute at a time.`}
          </Bullet>
          <Bullet>
            <strong className="font-semibold text-zinc-200">Nothing to install.</strong> The Ubuntu desktop runs in a
            browser tab. The VMs use whatever RDP or SSH client you already have.
          </Bullet>
          <Bullet>
            <strong className="font-semibold text-zinc-200">Isolated per tenant.</strong> Each machine is created for
            your account alone — its own container or its own KVM guest, its own credentials, its own access port.
          </Bullet>
        </ul>
      </GuideSection>

      {/* ------------------------------------------------------- started ---- */}
      <GuideSection
        id="start"
        icon={<Rocket className="h-4 w-4" aria-hidden="true" />}
        title="Getting started"
        sub="Six steps, start to finish."
      >
        <ol className="list-none space-y-4 p-0">
          {[
            {
              t: 'Register',
              d: (
                <>
                  Pick a username (3–32 characters: letters, numbers, <code className="font-mono text-zinc-300">_ . -</code>)
                  and a password of at least 6 characters. Nothing else is asked for, and nothing is verified.
                </>
              ),
            },
            {
              t: 'Your first machine is free',
              d: (
                <>
                  {freeMachines === undefined
                    ? 'Your free allowance runs without a balance, so you do not need to top up to try it.'
                    : `${freeMachines === 1 ? 'One machine' : `${freeMachines} machines`} can run without a balance, so you do not have to top up to try it.`}{' '}
                  Top up only when you want to run more than that at once.
                </>
              ),
            },
            {
              t: 'Deploy',
              d: (
                <>
                  In the console, pick <strong className="text-zinc-200">Ubuntu GPU Session</strong> for the GPU, or a
                  Windows / Linux VM for plain compute. The session comes up once the node reports the container
                  running; a Windows or Linux VM has to clone a full disk image first, which takes minutes.
                </>
              ),
            },
            {
              t: 'Connect',
              d: (
                <>
                  An Ubuntu session gets an <strong className="text-zinc-200">Open desktop</strong> button that loads
                  the desktop in a new tab. A VM shows its host, port, username and password on its card — see{' '}
                  <a href="#connecting-h" className="text-cyan-400 underline-offset-2 hover:underline">Connecting</a> below.
                </>
              ),
            },
            {
              t: 'Stop when you are done',
              d: (
                <>
                  <strong className="text-zinc-200">Stop</strong> shuts the machine down. Billing counts only machines
                  that are running, so a stopped machine costs nothing and no longer counts toward your concurrent
                  limit.
                </>
              ),
            },
            {
              t: 'Delete to clear it',
              d: (
                <>
                  <strong className="text-zinc-200">Delete</strong> removes the machine for good and reclaims it on the
                  host, along with anything left on its disk. It is only offered for a stopped or failed machine —
                  a running one has to be stopped first.
                </>
              ),
            },
          ].map((s, i) => (
            <li key={s.t} className="flex gap-4">
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-cyan-400/30 bg-cyan-400/10 font-mono text-sm font-bold text-cyan-300"
              >
                {i + 1}
              </span>
              <div className="min-w-0 pt-0.5">
                <h3 className="text-sm font-semibold text-zinc-100">
                  <span className="sr-only">Step {i + 1}: </span>{s.t}
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-zinc-400">{s.d}</p>
              </div>
            </li>
          ))}
        </ol>

        {onGetStarted && (
          <button type="button" onClick={onGetStarted} className={cx(BTN_PRIMARY, 'mt-6 w-full py-3 text-sm sm:w-auto sm:px-6')}>
            Create an account <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </button>
        )}
      </GuideSection>

      {/* ----------------------------------------------------- connecting ---- */}
      <GuideSection
        id="connecting"
        icon={<Plug className="h-4 w-4" aria-hidden="true" />}
        title="Connecting to each type"
        sub="The console fills the placeholders in for you on each machine card."
      >
        <div className="space-y-5">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
              <Terminal className="h-4 w-4 text-emerald-400" aria-hidden="true" /> Ubuntu GPU session
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
              Nothing to type. Once the session is running, its card shows{' '}
              <strong className="text-zinc-200">Open desktop</strong>, which opens the noVNC desktop in a new browser
              tab and connects on its own. The VNC password is on the card too, in case the client asks for it. While
              the session is still starting, opening it shows a "desktop is starting" page that retries by itself.
            </p>
          </div>

          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
              <Server className="h-4 w-4 text-violet-400" aria-hidden="true" /> Linux VM — SSH
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
              The card gives you the host and the port. The port is per-machine, so it always has to be passed
              explicitly:
            </p>
            <Cmd>{sshCommand('<host>', '<port>', 'rent')}</Cmd>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
              The card shows the exact username and the generated password, and offers the whole command as a single
              copy button.
            </p>
          </div>

          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
              <Laptop className="h-4 w-4 text-cyan-400" aria-hidden="true" /> Windows VM — RDP
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
              Paste <code className="font-mono text-zinc-300">&lt;host&gt;:&lt;port&gt;</code> into the computer field
              of any RDP client, or from a Windows command prompt:
            </p>
            <Cmd>{rdpCommand('<host>', '<port>')}</Cmd>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
              Sign in with the username and password shown on the card.
            </p>
          </div>

          <p className="rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-xs leading-relaxed text-zinc-400">
            A VM has no host address while it is still <span className="font-mono text-amber-300">provisioning</span> —
            the address is written when the clone finishes and the machine flips to{' '}
            <span className="font-mono text-emerald-300">running</span>. Until then the card says it is waiting rather
            than showing you a placeholder to copy.
          </p>
        </div>
      </GuideSection>

      {/* -------------------------------------------------------- billing ---- */}
      <GuideSection
        id="billing"
        icon={<Wallet className="h-4 w-4" aria-hidden="true" />}
        title="Billing"
        sub="What is charged, when, and what is not."
      >
        <ul className="list-none space-y-3 p-0">
          <Bullet>
            <strong className="font-semibold text-zinc-200">Per minute, not per hour.</strong>{' '}
            {perHour === null
              ? 'Your balance is held in minutes.'
              : `Your balance is held in minutes, and the $${perHour}/hr rate is one balance minute per billed machine per minute of wall-clock time.`}{' '}
            Once a minute the server counts your running machines and deducts that many minutes.
          </Bullet>
          <Bullet>
            <strong className="font-semibold text-zinc-200">The free allowance comes off the top.</strong>{' '}
            {freeSubject} {freeVerb} not billed. Only machines beyond that draw down the balance.
          </Bullet>
          <Bullet>
            <strong className="font-semibold text-zinc-200">A stopped machine costs nothing.</strong> Only machines in
            the <span className="font-mono text-emerald-300">running</span> state are counted, so stopping is what
            stops the meter — you do not have to delete it to stop paying.
          </Bullet>
          <Bullet>
            <strong className="font-semibold text-zinc-200">You cannot overdraw.</strong> When the balance reaches
            zero, your machines are stopped automatically. There is no card on file and no negative balance.
          </Bullet>
          <Bullet>
            <strong className="font-semibold text-zinc-200">Top-ups wait for confirmation.</strong> Buying minutes
            creates a Bitcoin invoice. The balance is credited when the payment{' '}
            <em className="text-zinc-300">confirms</em> — the server credits on the settled notification from BTCPay,
            not when the invoice is first seen — so expect a wait between paying and the balance moving. The console
            watches for it and tells you the moment it lands.
          </Bullet>
          <Bullet>
            <strong className="font-semibold text-zinc-200">Concurrency is capped.</strong>{' '}
            {maxMachines === undefined
              ? 'There is a limit on how many machines you can run at once; going past it is refused.'
              : `Up to ${maxMachines} machines at once per account. Deploying past that is refused — stop one first.`}
          </Bullet>
        </ul>

        {perHour !== null && (
          <p className="mt-4 rounded-xl border border-amber-400/25 bg-amber-400/5 px-4 py-3 text-sm text-amber-100">
            <Bitcoin className="mr-2 inline h-4 w-4 align-text-bottom text-amber-400" aria-hidden="true" />
            At ${perHour}/hr, a $5 invoice credits{' '}
            <span className="font-mono font-bold">{Math.floor((5 / perHour) * 60)}</span> minutes of billed runtime.
          </p>
        )}
      </GuideSection>

      {/* ------------------------------------------------------- capacity ---- */}
      <GuideSection
        id="capacity"
        icon={<Cpu className="h-4 w-4" aria-hidden="true" />}
        title="GPU capacity"
        sub="The card is shared. Here is exactly what that means for you."
      >
        <p className="text-sm leading-relaxed text-zinc-400">
          The GPU that backs Ubuntu sessions is shared with another workload on the same host. Free VRAM genuinely
          moves up and down as that workload runs, which is why this site shows a live reading instead of a fixed
          specification.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-zinc-400">
          Before a session starts, the gateway checks the node's real free VRAM against a minimum
          {capacity.minMb > 0
            ? <> of <span className="font-mono text-zinc-200">{Math.round(capacity.minMb)} MiB</span></>
            : ' the gateway sets'}
          . Below it, the spawn is refused with a message saying exactly that, and{' '}
          <strong className="font-semibold text-zinc-200">nothing is charged</strong>. That is deliberate: handing over
          a GPU desktop that cannot fit anything on the GPU, and billing for it, would be the dishonest option.
        </p>

        <div className="mt-4 rounded-xl border border-white/10 bg-black/30 px-4 py-3">
          <div className="text-[10px] font-medium uppercase tracking-widest text-zinc-500">Right now</div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            {/* Only the coarse state word is announced. The megabyte figure
                changes on every poll and would be re-read continuously. */}
            <span
              aria-live="polite"
              className={cx(
                'font-mono text-xl font-bold',
                capacity.state === 'ready' ? 'text-emerald-300'
                  : capacity.state === 'busy' ? 'text-amber-300'
                    : capacity.state === 'offline' ? 'text-red-300'
                      : 'text-zinc-500',
              )}
            >
              {capacity.status}
            </span>
            {capacity.figure && (
              <span className="font-mono text-sm text-zinc-400">{capacity.figure}</span>
            )}
          </div>
          <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">{capacity.detail}</p>
          {capacity.totalMb > 0 && capacity.state !== 'offline' && (
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
              <div
                className={cx(
                  'h-full rounded-full transition-[width] duration-500',
                  capacity.state === 'ready' ? 'bg-emerald-400' : capacity.state === 'busy' ? 'bg-amber-400' : 'bg-zinc-600',
                )}
                style={{ width: `${Math.min(100, Math.max(0, (capacity.freeMb / capacity.totalMb) * 100))}%` }}
              />
            </div>
          )}
        </div>

        <p className="mt-3 text-xs leading-relaxed text-zinc-500">
          Windows and Linux VMs do not use the GPU, so this reading does not gate them.
        </p>
      </GuideSection>

      {/* ------------------------------------------------------- troubles ---- */}
      <GuideSection
        id="faq"
        icon={<LifeBuoy className="h-4 w-4" aria-hidden="true" />}
        title="When something goes wrong"
        sub="The messages you are most likely to hit, and what each one means."
      >
        <div className="space-y-2">
          <Faq q="&quot;GPU at capacity&quot; when spawning a session">
            <p>
              Another workload is holding the card and free VRAM is below the floor a session needs. This is not a
              fault and not a queue — capacity fluctuates, and it often clears within minutes.
            </p>
            <p>
              <strong className="text-zinc-200">Nothing is charged</strong> for a refused spawn. Wait for the capacity
              reading above to go green and try again.
            </p>
          </Faq>

          <Faq q="&quot;Insufficient balance&quot;">
            <p>
              {freeSubject} {freeVerb} free, but a machine beyond that needs a balance. This message means the free
              allowance is already in use and the balance is zero.
            </p>
            <p>Stop a machine you are not using, or buy minutes with Bitcoin.</p>
          </Faq>

          <Faq q="My machine has been &quot;provisioning&quot; for a while">
            <p>
              A Windows or Linux VM is cloned from a full disk template before it boots. Windows images are large and
              this legitimately takes minutes. The card updates itself — no need to reload.
            </p>
            <p>
              If it ends up <span className="font-mono text-red-300">failed</span> instead, nothing was charged for it;
              delete it and deploy again.
            </p>
          </Faq>

          <Faq q="I can't delete a machine">
            <p>
              Delete is refused while a machine is still running, with{' '}
              <em className="text-zinc-300">"stop the machine first"</em>. Stop it, wait for the state to reach{' '}
              <span className="font-mono text-zinc-300">stopped</span>, and the delete button appears.
            </p>
            <p>
              The guard exists so the guest on the host is always reclaimed properly rather than being left orphaned
              with nothing pointing at it.
            </p>
          </Faq>

          <Faq q="&quot;No free ports&quot;">
            <p>
              Every machine gets a dedicated access port from a fixed range, and every port in that range is currently
              in use. Nothing was charged. Try again shortly — ports come back as machines are stopped and deleted.
            </p>
          </Faq>

          <Faq q="I forgot my password">
            <p>
              If you are still signed in somewhere, change it under{' '}
              <strong className="text-zinc-200">Settings → Security</strong>. That form needs your current password,
              and it signs every other device out.
            </p>
            <p>
              If you are locked out, there is no recovery. Accounts carry no email, so there is nothing to send a reset
              to — that is the trade for asking you for nothing at sign-up.
            </p>
          </Faq>

          <Faq q="I was signed out for no reason">
            <p>
              Access tokens are held in the gateway's memory by design, not written to disk, so a restart invalidates
              every token at once. Sign in again with the same username and password.
            </p>
            <p>
              Nothing else is lost: your balance, machines and invoices live in the database and are exactly where you
              left them.
            </p>
          </Faq>
        </div>
      </GuideSection>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-6">
        <p className="flex items-center gap-2 text-xs text-zinc-600">
          <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
          Figures on this page come from the gateway's public status endpoint and update on their own.
        </p>
        <div className="flex flex-wrap gap-2">
          {onGetStarted && (
            <button type="button" onClick={onGetStarted} className={cx(BTN_PRIMARY, 'px-4 py-2 text-sm')}>
              Launch console <ExternalLink className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
          <button type="button" onClick={onBack} className={cx(BTN_GHOST, 'px-4 py-2 text-sm')}>
            <ArrowRight className="h-4 w-4 rotate-180" aria-hidden="true" /> {backLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
