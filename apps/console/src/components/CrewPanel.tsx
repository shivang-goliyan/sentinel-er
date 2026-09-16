import { CREW } from '@sentinel/shared'
import type { Actor } from '@sentinel/shared'
import { actorJob, actorLabel, utcTime } from '../lib/format'
import type { CrewLine } from '../store/fold'
import { useConsole } from '../store/stream'
import { Panel } from './ui'

function StateMark({ line }: { line: CrewLine | undefined }) {
  if (!line || line.state === 'idle') return <span className="size-2 rounded-full border border-faint" />
  if (line.state === 'working') {
    return (
      <span className="relative h-2 w-5 overflow-hidden rounded-full bg-info/20">
        <span className="absolute inset-y-0 w-2/5 animate-sweep rounded-full bg-info" />
      </span>
    )
  }
  const color = { done: 'bg-good', blocked: 'bg-warn', error: 'bg-bad' }[line.state]
  return <span className={`size-2 rounded-full ${color}`} />
}

function Row({ actor, line }: { actor: Actor; line: CrewLine | undefined }) {
  const tone =
    line?.state === 'error' ? 'text-bad' : line?.state === 'blocked' ? 'text-warn' : line ? 'text-paper-dim' : 'text-faint'
  return (
    <li className="grid grid-cols-[132px_minmax(0,1fr)] items-start gap-2 border-b border-line/70 px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-2 pt-px">
        <span className="flex w-5 justify-center">
          <StateMark line={line} />
        </span>
        <span className="font-label text-[15px] font-semibold uppercase tracking-[0.05em] text-paper">{actorLabel(actor)}</span>
      </div>
      <div className="min-w-0">
        <p className={`line-clamp-2 text-[13px] leading-snug ${tone}`} title={line?.text}>
          {line ? line.text : actorJob(actor)}
        </p>
        {line ? <p className="num mt-0.5 text-[10.5px] text-faint">{utcTime(line.ts)} UTC</p> : null}
      </div>
    </li>
  )
}

export function CrewPanel() {
  const crew = useConsole((s) => s.view.crew)
  const working = CREW.filter((a) => crew[a]?.state === 'working').length
  return (
    <Panel title="Crew" aside={working > 0 ? <span className="text-info">{working} working</span> : <span>standing by</span>} className="shrink-0" delay={60}>
      <ul>
        {CREW.map((a) => (
          <Row key={a} actor={a} line={crew[a]} />
        ))}
      </ul>
    </Panel>
  )
}
