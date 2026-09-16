import { useMemo } from 'react'
import { factRef } from '../../store/fold'
import { surgeRows, type SurgeRow } from '../../store/views'
import { useConsole } from '../../store/stream'
import { EmptyState, FactChip, Tag } from '../ui'

export function useSurge() {
  const facts = useConsole((s) => s.view.facts)
  const models = useConsole((s) => s.view.models)
  const runId = useConsole((s) => s.view.activeRunId)
  return useMemo(() => surgeRows({ facts, models }, runId), [facts, models, runId])
}

function EarlyFill({ row }: { row: SurgeRow }) {
  // only worth a second line when the high casualty estimate fills the hospital sooner
  const differs = useConsole((s) => {
    const run = s.view.activeRunId
    const { minutes_to_full: mid, minutes_to_full_early: early } = row.ids
    if (!run || !mid || !early) return false
    return s.view.facts[factRef(run, mid)]?.display !== s.view.facts[factRef(run, early)]?.display
  })
  if (!differs) return null
  return (
    <span className="block text-[12px] text-muted">
      high est. <FactChip id={row.ids.minutes_to_full_early} show="value" className="num" />
    </span>
  )
}

function Row({ row }: { row: SurgeRow }) {
  const hot = row.fillsFirst
  return (
    <tr className={`border-t border-line/60 align-top ${hot ? 'bg-bad/[0.08]' : 'hover:bg-ink-850'}`}>
      <td className={`py-1.5 pl-3 pr-2 ${hot ? 'shadow-[inset_3px_0_0_var(--color-bad)]' : ''}`}>
        <span className="block truncate text-paper" title={row.name}>
          {row.name}
        </span>
      </td>
      <td className="num px-2 py-1.5 text-right text-paper-dim">
        <FactChip id={row.ids.share} show="value" />
      </td>
      <td className="num px-2 py-1.5 text-right text-paper-dim">
        <FactChip id={row.ids.arrivals_3h} show="value" />
      </td>
      <td className="num px-2 py-1.5 text-right text-paper-dim">
        <FactChip id={row.ids.arrivals_6h} show="value" />
      </td>
      <td className={`px-2 py-1.5 text-right ${hot ? 'text-bad' : row.fills ? 'text-paper' : 'text-muted'}`}>
        <span className={row.fills ? 'num block whitespace-nowrap' : 'block text-[12px] leading-snug'}>
          <FactChip id={row.ids.minutes_to_full} show="value" />
        </span>
        <EarlyFill row={row} />
      </td>
      <td className="py-1.5 pl-2 pr-3 text-paper-dim">
        {row.ids.divert_to ? (
          <span className="flex min-w-0 items-baseline gap-1">
            <span className="text-faint">→</span>
            <span className="truncate">
              <FactChip id={row.ids.divert_to} show="value" />
            </span>
          </span>
        ) : (
          <span className="text-faint">none needed</span>
        )}
      </td>
    </tr>
  )
}

export function SurgeTable() {
  const rows = useSurge()
  const first = rows.find((r) => r.fillsFirst)
  if (!rows.length) {
    return (
      <EmptyState title="Hospital surge" compact>
        Which hospital fills first, arrivals at 3 and 6 hours against real bed counts, and where to divert. Appears when the ledger reaches Surge.
      </EmptyState>
    )
  }
  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-7 shrink-0 items-center gap-2 border-b border-line/70 px-3" title="Rows are ordered by who fills first">
        <h3 className="font-label text-[14px] font-bold uppercase tracking-[0.12em] text-paper">Hospital surge</h3>
        {first ? (
          <>
            <Tag tone="bad">fills first</Tag>
            <span className="min-w-0 truncate text-[13px] text-paper-dim">
              <span className="text-paper">{first.name}</span>
              <span className="text-faint"> · </span>
              <FactChip id={first.ids.capacity} show="value" className="num" /> surge-ready beds
              <span className="text-faint"> · </span>
              <FactChip id={first.ids.drive} show="value" className="num" /> min drive
            </span>
          </>
        ) : (
          <span className="truncate text-[13px] text-muted">No hospital on the list fills within three days</span>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full table-fixed border-collapse text-[13px]">
          <colgroup>
            <col />
            <col className="w-[54px]" />
            <col className="w-[50px]" />
            <col className="w-[50px]" />
            <col className="w-[98px]" />
            <col className="w-[32%]" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-ink-900">
            <tr className="whitespace-nowrap text-left font-label text-[12px] font-semibold uppercase tracking-[0.06em] text-faint">
              <th className="py-1 pl-3 pr-2 font-semibold">Hospital</th>
              <th className="px-2 py-1 text-right font-semibold" title="Share of expected casualties heading here">
                Share
              </th>
              <th className="px-2 py-1 text-right font-semibold" title="Expected arrivals within three hours">
                By 3 h
              </th>
              <th className="px-2 py-1 text-right font-semibold" title="Expected arrivals within six hours">
                By 6 h
              </th>
              <th className="px-2 py-1 text-right font-semibold">Full in</th>
              <th className="py-1 pl-2 pr-3 font-semibold">Divert to</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row key={r.id} row={r} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
