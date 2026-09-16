import { useMemo } from 'react'
import { lifelineView, type LifelineRow } from '../../store/views'
import { useConsole } from '../../store/stream'
import { EmptyState, FactChip } from '../ui'

function useLifeline() {
  const facts = useConsole((s) => s.view.facts)
  const latestFactByKey = useConsole((s) => s.view.latestFactByKey)
  const models = useConsole((s) => s.view.models)
  const runId = useConsole((s) => s.view.activeRunId)
  return useMemo(() => lifelineView({ facts, latestFactByKey, models }, runId), [facts, latestFactByKey, models, runId])
}

function Row({ row }: { row: LifelineRow }) {
  return (
    <tr className="border-t border-line/60 hover:bg-ink-850">
      <td className="num py-1.5 pl-3 pr-1 text-paper">
        <FactChip id={row.ids.code} show="value" />
      </td>
      <td className="num px-1 py-1.5 text-right text-paper-dim">
        <FactChip id={row.ids.power_dependent} show="value" />
      </td>
      <td className="px-1 py-1.5">
        <span className="flex items-center justify-end gap-1.5">
          <span className="relative h-[5px] w-9 overflow-hidden rounded-full bg-ink-700" aria-hidden>
            {row.outage !== null ? (
              <span className="absolute inset-y-0 left-0 rounded-full bg-warn" style={{ width: `${row.outage * 100}%` }} />
            ) : null}
          </span>
          <span className="num w-9 text-right text-warn">
            <FactChip id={row.ids.outage_probability} show="value" />
          </span>
        </span>
      </td>
      <td className="num px-1 py-1.5 text-right text-paper">
        <FactChip id={row.ids.at_risk} show="value" />
      </td>
      <td className="num whitespace-nowrap py-1.5 pl-1 pr-3 text-right text-paper-dim">
        {row.ids.restoration ? <FactChip id={row.ids.restoration} show="value" /> : <span className="text-faint">—</span>}
      </td>
    </tr>
  )
}

const NOTE = 'Aggregate HHS emPOWER counts. Nobody is called at home: we call the county, suppliers and shelters.'

export function LifelineList() {
  const view = useLifeline()
  if (!view) {
    return (
      <EmptyState title="Lifeline by ZIP">
        Medicare patients on powered equipment at home, from HHS emPOWER aggregate counts, set against the chance their power fails. We call the county, suppliers and shelters — never patients.
      </EmptyState>
    )
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2.5 border-b border-line/70 px-3 py-1.5">
        <span className="num text-[26px] font-medium leading-none text-paper">
          {view.totalId ? <FactChip id={view.totalId} show="value" /> : <span className="text-faint">—</span>}
        </span>
        <span className="min-w-0 text-[13px] leading-[1.25] text-paper-dim">
          power-dependent residents
          <br />
          likely to lose power
          {view.zipCountId ? (
            <span className="text-muted">
              {' '}
              · <FactChip id={view.zipCountId} show="value" className="num" /> ZIPs
            </span>
          ) : null}
        </span>
      </div>
      {view.rows.length ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <table className="w-full table-fixed border-collapse text-[13px]">
            <colgroup>
              <col className="w-[54px]" />
              <col />
              <col className="w-[80px]" />
              <col className="w-[54px]" />
              <col className="w-[78px]" />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-ink-900">
              <tr className="whitespace-nowrap font-label text-[12px] font-semibold uppercase tracking-[0.06em] text-faint">
                <th className="py-1 pl-3 pr-1 text-left font-semibold">ZIP</th>
                <th className="px-1 py-1 text-right font-semibold" title="Medicare residents on powered medical equipment at home">
                  On power
                </th>
                <th className="px-1 py-1 text-right font-semibold">Outage</th>
                <th className="px-1 py-1 text-right font-semibold" title="Power-dependent residents likely to lose power">
                  At risk
                </th>
                <th className="py-1 pl-1 pr-3 text-right font-semibold" title="Expected wait for power to return, if it goes out">
                  Back in
                </th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((r) => (
                <Row key={r.zcta} row={r} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="No ZIP rows" compact>
          The lifeline model returned a total but no ZIP breakdown.
        </EmptyState>
      )}
      <p className="shrink-0 truncate border-t border-line/70 px-3 py-1 text-[12px] text-muted" title={NOTE}>
        Aggregate HHS counts · nobody is called at home
      </p>
    </div>
  )
}
