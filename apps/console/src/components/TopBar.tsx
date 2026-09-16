import { useMemo, useState } from 'react'
import { latestAnchor } from '../store/fold'
import { operatorPost, refreshServerState, useConsole } from '../store/stream'
import { clock, shortDate, zoneName } from '../lib/format'
import { useActiveEvent, useActiveRun, useMode, useNow } from '../lib/hooks'

function Wordmark() {
  return (
    <div className="flex items-center gap-3">
      <svg viewBox="0 0 32 32" className="size-8 shrink-0" aria-hidden>
        <path d="M16 3.5 27 8v8c0 6.6-4.7 11.2-11 13.5C9.7 27.2 5 22.6 5 16V8z" fill="none" stroke="currentColor" strokeWidth="2" className="text-paper" />
        <path d="M16 10.5v11M10.5 16h11" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" className="text-drill" />
      </svg>
      <div className="leading-none">
        <div className="font-label text-[22px] font-bold uppercase tracking-[0.16em] text-paper">Sentinel ER</div>
        <div className="mt-1 text-[11px] tracking-wide text-muted">Hospital incident console · public data only</div>
      </div>
    </div>
  )
}

export function ModeBadge() {
  const mode = useMode()
  if (mode.kind === 'drill') {
    return (
      <div className="flex h-11 items-stretch overflow-hidden rounded-[3px] border-2 border-drill" role="status" aria-label="Drill mode">
        <span className="hazard w-4" />
        <span className="flex items-center bg-drill px-4 font-label text-[26px] font-bold uppercase leading-none tracking-[0.22em] text-drill-ink">
          Drill
        </span>
        <span className="hazard w-4" />
      </div>
    )
  }
  if (mode.kind === 'live') {
    return (
      <div className="flex h-11 items-center gap-2.5 rounded-[3px] border-2 border-live bg-live/15 px-4" role="status" aria-label="Live mode">
        <span className="size-2.5 rounded-full bg-live" />
        <span className="font-label text-[26px] font-bold uppercase leading-none tracking-[0.22em] text-live">Live</span>
      </div>
    )
  }
  if (mode.kind === 'past') {
    return (
      <div className="flex h-11 items-center gap-3 rounded-[3px] border-2 border-past bg-past/10 px-4" role="status">
        <span className="font-label text-[22px] font-bold uppercase leading-none tracking-[0.18em] text-past">{mode.label}</span>
        {mode.detail ? <span className="num text-[13px] text-past/80">{/^\d{4}-/.test(mode.detail) ? shortDate(mode.detail) : mode.detail}</span> : null}
      </div>
    )
  }
  return (
    <div className="flex h-11 items-center rounded-[3px] border-2 border-line-strong px-4">
      <span className="font-label text-[20px] font-semibold uppercase tracking-[0.18em] text-faint">Connecting</span>
    </div>
  )
}

function Incident() {
  const run = useActiveRun()
  const event = useActiveEvent()
  if (!run) {
    return (
      <div className="min-w-0 leading-tight">
        <div className="text-[11px] uppercase tracking-[0.14em] text-faint">Incident</div>
        <div className="truncate text-[15px] text-muted">No active incident</div>
      </div>
    )
  }
  const tier = event ? event.tier : null
  return (
    <div className="min-w-0 leading-tight">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-faint">
        Incident{tier !== null ? <span className="text-paper-dim">· Tier {tier}</span> : null}
        {run.ended ? <span className="text-muted">· {run.ended.status}</span> : null}
      </div>
      <div className="truncate text-[16px] font-semibold text-paper" title={run.title}>
        {run.title}
      </div>
    </div>
  )
}

function Clocks() {
  const now = useNow(1000)
  const event = useActiveEvent()
  const eventTz = event && typeof event.severity.tz === 'string' ? event.severity.tz : null
  const cells: { label: string; value: string }[] = []
  if (eventTz) cells.push({ label: `Event · ${zoneName(eventTz)}`, value: clock(now, eventTz) })
  cells.push({ label: 'UTC', value: clock(now, 'UTC') })
  cells.push({ label: `Here · ${zoneName()}`, value: clock(now) })
  return (
    <div className="flex items-center gap-4">
      {cells.map((c) => (
        <div key={c.label} className="text-right leading-none">
          <div className="text-[10px] uppercase tracking-[0.14em] text-faint">{c.label}</div>
          <div className="num mt-1 text-[17px] text-paper">{c.value}</div>
        </div>
      ))}
    </div>
  )
}

function ApprovalSwitch() {
  const fromLog = useConsole((s) => s.view.switches.approval)
  const server = useConsole((s) => s.server)
  const on = fromLog ?? server?.approval_on ?? null
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const flip = () => {
    if (on === null) return
    setBusy(true)
    setNote(null)
    void operatorPost('/api/switch/approval', { on: !on }, (r) => {
      setBusy(false)
      if (r && !r.ok) setNote(r.message)
      else void refreshServerState()
    }).then((r) => {
      if (r === null) setBusy(false)
    })
  }

  return (
    <div className="flex items-center gap-2.5">
      <div className="text-right leading-none">
        <div className="text-[10px] uppercase tracking-[0.14em] text-faint">Human approval</div>
        <div className={`mt-1 font-label text-[16px] font-semibold uppercase tracking-[0.1em] ${on ? 'text-good' : on === false ? 'text-bad' : 'text-faint'}`}>
          {on === null ? '—' : on ? 'Required' : 'Off'}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on ?? false}
        aria-label="Require human approval for every call"
        disabled={on === null || busy}
        onClick={flip}
        title={note ?? 'Operator only'}
        className={`relative h-7 w-12 rounded-full border transition-colors disabled:opacity-50 ${on ? 'border-good/60 bg-good/25' : 'border-line-strong bg-ink-800'}`}
      >
        <span className={`absolute top-[3px] size-5 rounded-full transition-all ${on ? 'left-[23px] bg-good' : 'left-[3px] bg-muted'}`} />
      </button>
    </div>
  )
}

function ChainBadge() {
  const chain = useConsole((s) => s.chain)
  const chainError = useConsole((s) => s.chainError)
  const anchors = useConsole((s) => s.view.anchors)
  const anchor = useMemo(() => latestAnchor(anchors), [anchors])
  const setDrawer = useConsole((s) => s.setDrawer)

  let tone = 'border-line-strong text-faint'
  let main = 'Checking chain'
  let sub = chainError ?? 'Hash-chained log'
  if (chain?.ok) {
    tone = 'border-good/45 text-good'
    main = `Chain intact to #${chain.head_seq}`
    sub = anchor
      ? anchor.confirmed
        ? `Anchored at #${anchor.submitted.head_seq} · Bitcoin`
        : `Anchor pending for #${anchor.submitted.head_seq}`
      : 'Not anchored yet'
  } else if (chain && !chain.ok) {
    tone = 'border-bad bg-bad/10 text-bad'
    main = `Chain broken at #${chain.broken_at ?? '?'}`
    sub = 'An entry was changed after it was written'
  }
  return (
    <button
      type="button"
      onClick={() => setDrawer('chain')}
      className={`flex h-11 items-center gap-2.5 rounded-[3px] border px-3 text-left transition-colors hover:bg-ink-800 ${tone}`}
    >
      <svg viewBox="0 0 20 20" className="size-4 shrink-0" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="2" y="7" width="8" height="6" rx="3" />
        <rect x="10" y="7" width="8" height="6" rx="3" />
      </svg>
      <span className="leading-tight">
        <span className="block font-label text-[15px] font-semibold uppercase tracking-[0.08em]">{main}</span>
        <span className="block text-[11px] text-muted">{sub}</span>
      </span>
    </button>
  )
}

export function Connection() {
  const conn = useConsole((s) => s.conn)
  const label = { connecting: 'Connecting', live: 'Streaming', retrying: 'Reconnecting' }[conn]
  const color = { connecting: 'bg-faint', live: 'bg-good', retrying: 'bg-warn' }[conn]
  return (
    <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] text-muted" title="Live log stream">
      <span className={`size-1.5 rounded-full ${color}`} />
      {label}
    </div>
  )
}

export function TopBar() {
  const mode = useMode()
  return (
    <div className="shrink-0">
      {mode.kind === 'drill' ? <div className="hazard h-1.5" aria-hidden /> : null}
      {mode.kind === 'live' ? <div className="h-1.5 bg-live" aria-hidden /> : null}
      {mode.kind === 'past' ? <div className="h-1.5 bg-past" aria-hidden /> : null}
      <div className="flex h-[68px] items-center gap-6 border-b border-line bg-ink-950/90 px-4">
        <Wordmark />
        <ModeBadge />
        <div className="min-w-0 flex-1">
          <Incident />
        </div>
        <Clocks />
        <div className="h-9 w-px bg-line" />
        <ApprovalSwitch />
        <ChainBadge />
      </div>
    </div>
  )
}
