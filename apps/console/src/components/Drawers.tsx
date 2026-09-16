import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { roleLabel, shortDate, utcTime } from '../lib/format'
import { useActiveRun } from '../lib/hooks'
import { latestAnchor } from '../store/fold'
import {
  lockOperator,
  operatorPasscode,
  operatorPost,
  refreshServerState,
  useConsole,
  type DrawerName,
} from '../store/stream'
import { Btn, EmptyState, Tag } from './ui'
import { VoiceControls } from './VoiceControls'

const DRAWERS: { name: DrawerName; label: string }[] = [
  { name: 'sitrep', label: 'Sitrep' },
  { name: 'scout', label: 'Scout trail' },
  { name: 'models', label: 'Model cards' },
  { name: 'chain', label: 'Log & chain' },
  { name: 'operator', label: 'Operator' },
]

export function Dock() {
  const drawer = useConsole((s) => s.drawer)
  const setDrawer = useConsole((s) => s.setDrawer)
  const blocked = useConsole((s) => s.view.verify.filter((v) => v.verdict === 'block').length)
  const fetches = useConsole((s) => s.view.fetches.length)
  return (
    <nav className="flex h-10 shrink-0 items-center gap-1 rounded-[3px] border border-line bg-ink-900 px-1.5 animate-rise" style={{ animationDelay: '280ms' }}>
      {DRAWERS.map((d) => {
        const on = drawer === d.name
        const badge = d.name === 'sitrep' && blocked ? blocked : d.name === 'scout' && fetches ? fetches : null
        return (
          <button
            key={d.name}
            type="button"
            onClick={() => setDrawer(on ? null : d.name)}
            className={`flex h-7 items-center gap-1.5 rounded-[2px] px-3 font-label text-[14px] font-semibold uppercase tracking-[0.1em] transition-colors ${on ? 'bg-paper text-ink-950' : 'text-muted hover:bg-ink-800 hover:text-paper'}`}
          >
            {d.label}
            {badge !== null ? <span className={`num text-[11px] ${on ? 'text-ink-700' : 'text-faint'}`}>{badge}</span> : null}
          </button>
        )
      })}
    </nav>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-line px-5 py-4">
      <h3 className="panel-head mb-2">{title}</h3>
      {children}
    </section>
  )
}

function SitrepBody() {
  const run = useActiveRun()
  const sitrep = useConsole((s) => (run ? s.view.sitreps[run.id] : undefined))
  const verify = useConsole((s) => s.view.verify)
  const faults = useConsole((s) => s.view.faults)
  const artifacts = useConsole((s) => s.view.artifacts)
  const checks = useMemo(() => verify.filter((v) => v.channel === 'sitrep' && v.run_id === run?.id), [verify, run])
  const pdf = artifacts.findLast((a) => a.type === 'sitrep_pdf' && a.run_id === run?.id)
  const injected = faults.filter((f) => f.run_id === run?.id)

  if (!run) return <EmptyState title="No active run">The situation report is written for the incident in progress.</EmptyState>
  return (
    <>
      <Section title="Report">
        {sitrep?.final ? (
          <>
            <div className="mb-2 flex items-center gap-2">
              <Tag tone="good">verified</Tag>
              {sitrep.final.template ? <Tag tone="warn">template</Tag> : null}
              {pdf ? (
                <a href={pdf.url} className="text-[13px] text-info hover:underline" target="_blank" rel="noreferrer">
                  Download PDF
                </a>
              ) : null}
            </div>
            <pre className="whitespace-pre-wrap font-sans text-[14px] leading-relaxed text-paper">{sitrep.final.text}</pre>
          </>
        ) : (
          <p className="text-[13px] text-muted">
            Not written yet. The Analyst drafts it from verified facts once the models finish, and the Verifier checks every number before it's released.
          </p>
        )}
      </Section>
      <Section title="Verifier">
        {injected.map((f) => (
          <p key={f.seq} className="mb-2 text-[13px] text-warn">
            Injected on purpose: {f.detail}
          </p>
        ))}
        {checks.length === 0 ? (
          <p className="text-[13px] text-muted">No checks for this run yet.</p>
        ) : (
          <ul className="space-y-2">
            {checks.map((c) => (
              <li key={c.seq} className="text-[13px]">
                <div className="flex items-center gap-2">
                  <Tag tone={c.verdict === 'pass' ? 'good' : 'bad'}>{c.verdict === 'pass' ? 'passed' : 'blocked'}</Tag>
                  <span className="text-paper-dim">{c.target}</span>
                  <span className="num text-[11px] text-faint">{utcTime(c.ts)}</span>
                </div>
                {c.findings.map((f, i) => (
                  <p key={i} className="mt-1 pl-1 text-muted">
                    {f.text}
                    {f.expected ? <span className="text-paper-dim"> — source says {f.expected}</span> : null}
                    {f.source ? <span className="text-faint"> ({f.source.name})</span> : null}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Section>
      {sitrep?.drafts.length ? (
        <Section title={`Drafts (${sitrep.drafts.length})`}>
          {sitrep.drafts.map((d) => (
            <details key={d.seq} className="mb-2">
              <summary className="cursor-pointer text-[13px] text-paper-dim">
                Draft {d.attempt} · <span className="num">{utcTime(d.ts)}</span>
              </summary>
              <pre className="mt-1 whitespace-pre-wrap font-sans text-[13px] text-muted">{d.text}</pre>
            </details>
          ))}
        </Section>
      ) : null}
    </>
  )
}

function ScoutBody() {
  const fetches = useConsole((s) => s.view.fetches)
  const rows = useMemo(() => fetches.slice().reverse(), [fetches])
  if (!rows.length) {
    return (
      <EmptyState title="No sources read yet">
        When the Scout profiles a hospital, every page and dataset it reads shows up here as it happens, with the status and a snippet.
      </EmptyState>
    )
  }
  return (
    <ol>
      {rows.map((f) => (
        <li key={f.seq} className="border-b border-line/60 px-5 py-2.5">
          <div className="flex items-center gap-2">
            <Tag tone={f.status >= 400 ? 'bad' : 'plain'}>{f.status}</Tag>
            <span className="text-[13px] text-paper-dim">{f.source}</span>
            {f.from_tape ? <Tag tone="warn">tape</Tag> : null}
            <span className="num ml-auto text-[11px] text-faint">{utcTime(f.ts)}</span>
          </div>
          <a href={f.url} target="_blank" rel="noreferrer" className="mt-1 block truncate text-[12px] text-info hover:underline">
            {f.url}
          </a>
          {f.snippet ? <p className="mt-1 line-clamp-3 text-[12px] text-muted">{f.snippet}</p> : null}
        </li>
      ))}
    </ol>
  )
}

function ModelsBody() {
  const models = useConsole((s) => s.view.models)
  if (!models.length) {
    return (
      <EmptyState title="No model output yet">
        The casualty model and the smoke-to-ED model report here: validation against held-out events, the features behind each estimate, and a bias check by region.
      </EmptyState>
    )
  }
  return (
    <ul>
      {models
        .slice()
        .reverse()
        .map((m) => (
          <li key={m.seq} className="border-b border-line/60 px-5 py-3">
            <p className="text-[14px] text-paper">
              {m.model} <span className="text-faint">{m.version}</span>
            </p>
            <p className="num text-[11px] text-faint">{utcTime(m.ts)} UTC</p>
          </li>
        ))}
    </ul>
  )
}

function ChainBody() {
  const chain = useConsole((s) => s.chain)
  const chainError = useConsole((s) => s.chainError)
  const anchors = useConsole((s) => s.view.anchors)
  const fallbacks = useConsole((s) => s.view.fallbacks)
  const errors = useConsole((s) => s.view.errors)
  const head = useConsole((s) => s.view.head)
  const anchor = latestAnchor(anchors)
  return (
    <>
      <Section title="Hash chain">
        {chain ? (
          <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-y-1 text-[13px]">
            <dt className="text-muted">Status</dt>
            <dd className={chain.ok ? 'text-good' : 'text-bad'}>
              {chain.ok ? 'Intact' : `Broken at entry #${chain.broken_at ?? '?'}`}
            </dd>
            <dt className="text-muted">Entries checked</dt>
            <dd className="num text-paper">{chain.checked}</dd>
            <dt className="text-muted">Head</dt>
            <dd className="num text-paper">#{chain.head_seq}</dd>
            <dt className="text-muted">Head hash</dt>
            <dd className="num break-all text-[12px] text-paper-dim">{chain.head_hash}</dd>
            <dt className="text-muted">Checked</dt>
            <dd className="num text-paper-dim">{utcTime(chain.checked_at)} UTC</dd>
            <dt className="text-muted">In this view</dt>
            <dd className="num text-paper-dim">up to #{head}</dd>
          </dl>
        ) : (
          <p className="text-[13px] text-muted">{chainError ?? 'Waiting for the first check.'}</p>
        )}
        <p className="mt-3 text-[12px] leading-relaxed text-faint">
          Every entry's hash covers the one before it, so changing any past entry breaks every hash after it.
        </p>
      </Section>
      <Section title="Public anchor">
        {anchor ? (
          <p className="text-[13px] text-paper-dim">
            Head #{anchor.submitted.head_seq} sent to OpenTimestamps at <span className="num">{utcTime(anchor.submitted.ts)}</span> UTC.{' '}
            {anchor.confirmed ? (
              <span className="text-good">
                Confirmed on Bitcoin{anchor.confirmed.block_height ? ` in block ${anchor.confirmed.block_height}` : ''}.
              </span>
            ) : (
              <span className="text-warn">Waiting for a Bitcoin block; that takes hours.</span>
            )}
          </p>
        ) : (
          <p className="text-[13px] text-muted">Not anchored yet. The chain head is anchored at the end of each run.</p>
        )}
      </Section>
      <Section title={`Fallbacks (${fallbacks.length})`}>
        {fallbacks.length === 0 ? (
          <p className="text-[13px] text-muted">Every source answered live.</p>
        ) : (
          fallbacks
            .slice()
            .reverse()
            .map((f) => (
              <p key={f.seq} className="text-[13px] text-warn">
                <span className="num text-faint">{utcTime(f.ts)}</span> {f.source}: {f.reason}
              </p>
            ))
        )}
      </Section>
      <Section title={`Errors (${errors.length})`}>
        {errors.length === 0 ? (
          <p className="text-[13px] text-muted">None logged.</p>
        ) : (
          errors
            .slice()
            .reverse()
            .map((e) => (
              <p key={e.seq} className="text-[13px] text-bad">
                <span className="num text-faint">{utcTime(e.ts)}</span> {e.where}: {e.message}
              </p>
            ))
        )}
      </Section>
    </>
  )
}

function OperatorBody() {
  const server = useConsole((s) => s.server)
  const drillFromLog = useConsole((s) => s.view.switches.drill)
  const whitelist = useConsole((s) => s.view.whitelist)
  const runs = useConsole((s) => s.view.runOrder.length)
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [unlocked, setUnlocked] = useState(() => operatorPasscode() !== null)
  const drillOn = drillFromLog ?? server?.drill_on ?? null
  const entries = Object.values(whitelist)

  const postNote = (ev: FormEvent) => {
    ev.preventDefault()
    const text = note.trim()
    if (!text) return
    void operatorPost('/api/operator/note', { text }, (r) => {
      setUnlocked(operatorPasscode() !== null)
      if (r?.ok) {
        setNote('')
        setMsg('Note added to the log.')
      } else if (r) setMsg(r.message)
    })
  }

  const flipDrill = () => {
    if (drillOn === null) return
    void operatorPost('/api/switch/drill', { on: !drillOn }, (r) => {
      setUnlocked(operatorPasscode() !== null)
      if (r?.ok) void refreshServerState()
      else if (r) setMsg(r.message)
    })
  }

  return (
    <>
      <Section title="Access">
        <div className="flex items-center justify-between">
          <p className="text-[13px] text-paper-dim">{unlocked ? 'Unlocked in this tab.' : 'Locked. Actions below ask for the passcode.'}</p>
          {unlocked ? (
            <Btn
              onClick={() => {
                lockOperator()
                setUnlocked(false)
              }}
            >
              Lock
            </Btn>
          ) : null}
        </div>
      </Section>
      <Section title="Drill mode">
        <div className="flex items-center justify-between gap-4">
          <p className="text-[13px] text-muted">
            While drill mode is on, every screen and call says DRILL and calls go only to whitelisted numbers.
          </p>
          <Btn kind={drillOn ? 'danger' : 'primary'} onClick={flipDrill} disabled={drillOn === null}>
            {drillOn ? 'Turn off' : 'Turn on'}
          </Btn>
        </div>
      </Section>
      <VoiceControls />
      <Section title="Add a log note">
        <form onSubmit={postNote} className="flex gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What happened, in a sentence"
            className="h-8 min-w-0 flex-1 rounded-[3px] border border-line-strong bg-ink-950 px-2.5 text-[13px] text-paper outline-none placeholder:text-faint focus:border-drill"
          />
          <Btn type="submit" disabled={!note.trim()}>
            Add
          </Btn>
        </form>
        {msg ? <p className="mt-2 text-[12px] text-muted">{msg}</p> : null}
      </Section>
      <Section title={`Call whitelist (${entries.length})`}>
        {entries.length === 0 ? (
          <p className="text-[13px] text-muted">No numbers yet. A number is added only with a recorded consent click.</p>
        ) : (
          <ul className="space-y-1">
            {entries.map((w) => (
              <li key={w.masked} className="flex items-center gap-2 text-[13px]">
                <span className="num text-paper-dim">{w.masked}</span>
                <span className="text-paper">{w.label}</span>
                <span className="text-faint">· {roleLabel(w.role)}</span>
                <span className="num ml-auto text-[11px] text-faint">{shortDate(w.ts)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Runs">
        <p className="text-[13px] text-muted">
          {runs ? `${runs} run${runs === 1 ? '' : 's'} in this log.` : 'No runs yet.'} Controls for the drill, replays and the time machine sit here.
        </p>
      </Section>
    </>
  )
}

export function DrawerHost() {
  const drawer = useConsole((s) => s.drawer)
  const setDrawer = useConsole((s) => s.setDrawer)
  if (!drawer) return null
  const title = DRAWERS.find((d) => d.name === drawer)?.label ?? ''
  return (
    <aside
      className="fixed bottom-3 right-3 top-[132px] z-40 flex w-[520px] flex-col rounded-[4px] border border-line-strong bg-ink-850 shadow-[-18px_0_48px_rgb(0_0_0/0.45)]"
      aria-label={title}
    >
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-line px-5">
        <h2 className="font-label text-[18px] font-bold uppercase tracking-[0.12em] text-paper">{title}</h2>
        <button
          type="button"
          onClick={() => setDrawer(null)}
          className="flex size-8 items-center justify-center rounded-[3px] text-muted hover:bg-ink-750 hover:text-paper"
          aria-label="Close"
        >
          <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 3l10 10M13 3 3 13" />
          </svg>
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {drawer === 'sitrep' ? <SitrepBody /> : null}
        {drawer === 'scout' ? <ScoutBody /> : null}
        {drawer === 'models' ? <ModelsBody /> : null}
        {drawer === 'chain' ? <ChainBody /> : null}
        {drawer === 'operator' ? <OperatorBody /> : null}
      </div>
    </aside>
  )
}
