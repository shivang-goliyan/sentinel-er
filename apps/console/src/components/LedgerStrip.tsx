import { MILESTONES, milestoneLabel, shortDate, tPlus, utcTime } from '../lib/format'
import { useActiveRun } from '../lib/hooks'
import { useConsole } from '../store/stream'
import { Connection } from './TopBar'

export function LedgerStrip() {
  const run = useActiveRun()
  const unreadable = useConsole((s) => s.unreadable)

  const reached = run ? MILESTONES.filter((m) => run.ledger[m]) : []
  const last = reached.at(-1)

  return (
    <div className="flex h-12 shrink-0 items-stretch border-b border-line bg-ink-900/80">
      <div className="flex w-[152px] shrink-0 flex-col justify-center border-r border-line px-4 leading-none" title={run ? shortDate(run.detected_at) : undefined}>
        <span className="panel-head">Golden hour</span>
        <span className="num mt-1 text-[11px] text-faint">
          {run ? `T0 ${utcTime(run.detected_at)} UTC` : 'from detection'}
        </span>
      </div>
      <ol className="grid min-w-0 flex-1 grid-cols-10">
        {MILESTONES.map((m, i) => {
          const at = run?.ledger[m]
          const isLast = m === last
          return (
            <li
              key={m}
              className={`relative flex min-w-0 flex-col justify-center border-r border-line px-2.5 leading-none ${at ? '' : 'opacity-60'} ${isLast ? 'animate-arrive' : ''}`}
            >
              {at ? <span className={`absolute inset-x-0 top-0 h-[3px] ${isLast ? 'bg-drill' : 'bg-good/70'}`} /> : null}
              <span className="truncate font-label text-[13px] font-semibold uppercase tracking-[0.06em] text-muted" title={`Step ${i + 1}`}>
                {milestoneLabel(m)}
              </span>
              <span className={`num mt-1 text-[17px] ${at ? (isLast ? 'text-drill' : 'text-paper') : 'text-faint'}`}>
                {at && run ? tPlus(run.detected_at, at) : '—'}
              </span>
            </li>
          )
        })}
      </ol>
      <div className="flex w-[132px] shrink-0 flex-col items-end justify-center gap-1 px-4">
        <Connection />
        {unreadable > 0 ? <span className="text-[10px] text-bad">{unreadable} unreadable entries</span> : null}
      </div>
    </div>
  )
}
