import { useMemo } from 'react'
import { chart } from '../../lib/palette'
import { decadeTop, decades, logPos } from '../../lib/scale'
import { bandValues, casualtyView, type Band, type Contribution } from '../../store/views'
import { useConsole } from '../../store/stream'
import { EmptyState, FactChip, Tag } from '../ui'

export function useCasualties() {
  const facts = useConsole((s) => s.view.facts)
  const latestFactByKey = useConsole((s) => s.view.latestFactByKey)
  const models = useConsole((s) => s.view.models)
  const runId = useConsole((s) => s.view.activeRunId)
  return useMemo(() => casualtyView({ facts, latestFactByKey, models }, runId), [facts, latestFactByKey, models, runId])
}

function RangeGlyph({ band, top }: { band: Band; top: number }) {
  const v = bandValues(band)
  if (!v) return <div className="h-5" />
  const at = (x: number) => `${(logPos(x, top) * 100).toFixed(2)}%`
  return (
    <div className="relative h-5" aria-hidden>
      <div className="absolute inset-x-0 top-1/2 h-px bg-line-strong" />
      {decades(top).map((d) => (
        <div key={d} className="absolute top-[calc(50%-3px)] h-[7px] w-px bg-line-strong" style={{ left: at(d) }} />
      ))}
      <div
        className="absolute top-[calc(50%-5px)] h-[10px] rounded-[1px] border border-info/70 bg-info/25"
        style={{ left: at(v.p10), width: `calc(${at(v.p90)} - ${at(v.p10)})` }}
      />
      <div className="absolute top-[calc(50%-8px)] h-4 w-[2px] -translate-x-1/2 bg-info" style={{ left: at(v.p50) }} />
      <div className="absolute top-[calc(50%-9px)] h-[18px] w-[3px] -translate-x-1/2 rounded-[1px] bg-paper" style={{ left: at(v.p90) }} />
    </div>
  )
}

function Range({ band }: { band: Band }) {
  return (
    <p className="truncate text-[12px] text-muted">
      <span className="text-info">range</span>{' '}
      <span className="num text-paper-dim">
        <FactChip id={band.p10?.id} show="value" />–<FactChip id={band.p90?.id} show="value" />
      </span>
      <span className="text-faint"> · </span>
      <span className="text-info">median</span>{' '}
      <span className="num text-paper-dim">
        <FactChip id={band.p50?.id} show="value" />
      </span>
    </p>
  )
}

function Planning({ band }: { band: Band }) {
  const planning = band.planning ?? band.p90
  return (
    <span className="num block text-[32px] font-medium leading-none text-paper">
      {planning ? <FactChip id={planning.id} show="value" /> : <span className="text-faint">—</span>}
    </span>
  )
}

const label = 'font-label text-[13px] font-semibold uppercase tracking-[0.12em] text-muted'

function Drivers({ items, prior }: { items: Contribution[]; prior: number | null }) {
  const biggest = Math.max(...items.map((c) => Math.abs(c.value)), 1e-9)
  return (
    <div className="row-span-5 min-w-0 border-l border-line px-3 py-2">
      <p
        className={label}
        title={prior !== null ? `The model starts from a physical estimate of ${prior.toLocaleString('en-US')} deaths, then these features move it.` : undefined}
      >
        What moved the death estimate
      </p>
      {items.length ? (
        <ul className="mt-1.5 space-y-1">
          {items.map((c) => {
            const up = c.value > 0
            const w = `${((Math.abs(c.value) / biggest) * 50).toFixed(1)}%`
            return (
              <li
                key={c.feature}
                className="flex items-center gap-2.5"
                title={`${c.name}: ${up ? 'raised' : 'lowered'} the median (${c.value.toFixed(2)} on the log scale)`}
              >
                <span className="relative h-3 w-11 shrink-0" aria-hidden>
                  <span className="absolute inset-y-[-2px] left-1/2 w-px bg-line-strong" />
                  <span
                    className={`absolute inset-y-0 rounded-[1px] ${up ? 'left-1/2' : 'right-1/2'}`}
                    style={{ width: w, backgroundColor: up ? chart.up : chart.down }}
                  />
                </span>
                <span className="truncate text-[13px] text-paper-dim">{c.name}</span>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="mt-1 text-[12px] text-muted">No explanation came back with this estimate.</p>
      )}
      <p className="mt-1.5 flex items-center gap-3 text-[12px] text-faint">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2.5 rounded-[1px]" style={{ backgroundColor: chart.up }} /> raised it
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2.5 rounded-[1px]" style={{ backgroundColor: chart.down }} /> lowered it
        </span>
      </p>
    </div>
  )
}

export function CasualtyCard() {
  const view = useCasualties()
  if (!view) {
    return (
      <EmptyState title="Casualty estimate" compact>
        Expected deaths and injuries with an error band and the features that drove them. Appears when the ledger reaches Casualties.
      </EmptyState>
    )
  }
  const highs = [view.injured, view.deaths].map((b) => bandValues(b)?.p90 ?? 0)
  const top = decadeTop(Math.max(...highs))
  return (
    <section>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.25fr)] grid-rows-[auto_auto_auto_auto_1fr] gap-x-3 pl-3">
        <p className={`${label} pt-2`}>Injured</p>
        <p className={`${label} flex items-center justify-between gap-2 pt-2`}>
          Deaths
          <Tag tone="warn">screening estimate</Tag>
        </p>
        <Drivers items={view.contributions} prior={view.priorDeaths} />
        <Planning band={view.injured} />
        <Planning band={view.deaths} />
        <p className="col-span-2 mt-1 flex items-center gap-2 truncate text-[12px] text-paper-dim">
          <span className="inline-block h-3 w-[3px] shrink-0 rounded-[1px] bg-paper" />
          planning figure (high end of range)
          <span className="text-faint">· range: 10th to 90th percentile</span>
        </p>
        <div className="mt-1">
          <RangeGlyph band={view.injured} top={top} />
        </div>
        <div className="mt-1">
          <RangeGlyph band={view.deaths} top={top} />
        </div>
        <div className="pb-2">
          <Range band={view.injured} />
        </div>
        <div className="pb-2">
          <Range band={view.deaths} />
        </div>
      </div>
    </section>
  )
}
