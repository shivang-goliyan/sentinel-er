import { useMemo } from 'react'
import { currentFacts } from '../../store/fold'
import { useConsole } from '../../store/stream'
import { utcTime } from '../../lib/format'
import { EmptyState, FactHover, Panel } from '../ui'

export function FactsTable() {
  const all = useConsole((s) => s.view.facts)
  const factOrder = useConsole((s) => s.view.factOrder)
  const superseded = useConsole((s) => s.view.superseded)
  const runId = useConsole((s) => s.view.activeRunId)
  const facts = useMemo(
    () => currentFacts({ facts: all, factOrder, superseded }, runId).slice().reverse(),
    [all, factOrder, superseded, runId],
  )
  const replaced = useMemo(
    () => (runId ? Object.keys(superseded).filter((id) => all[id]?.run_id === runId).length : 0),
    [superseded, all, runId],
  )

  return (
    <Panel
      title="Verified facts"
      aside={
        facts.length ? (
          <span className="num">
            {facts.length} current{replaced ? ` · ${replaced} replaced` : ''}
          </span>
        ) : null
      }
      className="flex-1"
      bodyClass="overflow-y-auto"
      delay={240}
    >
      {facts.length === 0 ? (
        <EmptyState title="No facts for this run">
          Every number the crew can say or write is a fact with an ID, a value and a source. The language model may only cite them by ID; the Verifier blocks anything else.
        </EmptyState>
      ) : (
        <table className="w-full table-fixed border-collapse text-[13px]">
          <thead className="sticky top-0 z-10 bg-ink-900">
            <tr className="text-left text-[10.5px] uppercase tracking-[0.12em] text-faint">
              <th className="w-16 px-3 py-1.5 font-medium">ID</th>
              <th className="px-2 py-1.5 font-medium">Fact</th>
              <th className="w-32 px-2 py-1.5 text-right font-medium">Value</th>
              <th className="w-52 px-2 py-1.5 font-medium">Source</th>
              <th className="w-20 px-3 py-1.5 text-right font-medium">UTC</th>
            </tr>
          </thead>
          <tbody>
            {facts.map((f) => (
              <tr key={f.id} className="border-t border-line/60 hover:bg-ink-850">
                <td className="num px-3 py-1.5 text-muted">{f.id}</td>
                <td className="truncate px-2 py-1.5 text-paper-dim" title={f.key}>
                  {f.label}
                </td>
                <td className="num truncate px-2 py-1.5 text-right text-paper">
                  <FactHover fact={f} className="cursor-help">
                    {f.display}
                  </FactHover>
                </td>
                <td className="truncate px-2 py-1.5 text-muted">
                  {f.source.url ? (
                    <a className="hover:text-info" href={f.source.url} target="_blank" rel="noreferrer">
                      {f.source.name}
                    </a>
                  ) : (
                    f.source.name
                  )}
                </td>
                <td className="num px-3 py-1.5 text-right text-faint">{utcTime(f.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  )
}
