import { useMemo } from 'react'
import type { Fact } from '@sentinel/shared'
import { chart } from '../../lib/palette'
import type { Tone } from '../../lib/format'
import { barPos, nextDaysView, weekday, type NextDay, type NextHour, type NextView } from '../../lib/nextDays'
import { useConsole } from '../../store/stream'
import { EmptyState, FactChip, FactHover, Tag } from '../ui'

const DAY_WORD = ['', 'Day one', 'Day two', 'Day three']
const label = 'font-label text-[12px] font-semibold uppercase tracking-[0.08em] text-faint'
const SOURCE_COLOR = { hrrr: chart.model, cams: chart.other, none: chart.faint } as const
const BEYOND = 'Smoke past anything the model was checked against, so the percent is an extrapolation'
const CAUSE_TONE: Record<string, Tone> = { smoke: 'info', heat: 'bad', storm: 'warn', none: 'quiet' }

export function useNextDays() {
  const facts = useConsole((s) => s.view.facts)
  const latestFactByKey = useConsole((s) => s.view.latestFactByKey)
  const models = useConsole((s) => s.view.models)
  const runId = useConsole((s) => s.view.activeRunId)
  return useMemo(() => nextDaysView({ facts, latestFactByKey, models }, runId), [facts, latestFactByKey, models, runId])
}

const num = (f?: Fact) => (f && typeof f.value === 'number' ? f.value : null)

function BandBar({ p10, p50, p90, top, color }: { p10?: Fact; p50?: Fact; p90?: Fact; top: number; color: string }) {
  const lo = num(p10)
  const mid = num(p50)
  const hi = num(p90)
  const at = (v: number) => `${(barPos(v, top) * 100).toFixed(2)}%`
  return (
    <div className="relative mt-1 h-[10px]" aria-hidden>
      <div className="absolute inset-x-0 top-[4px] h-[2px] rounded-full bg-ink-700" />
      {lo !== null && hi !== null ? (
        <div
          className="absolute top-[2px] h-[6px] rounded-[1px]"
          style={{ left: at(lo), width: `calc(${at(hi)} - ${at(lo)})`, minWidth: 2, backgroundColor: color, opacity: 0.35 }}
        />
      ) : null}
      {mid !== null ? <div className="absolute top-0 h-[10px] w-[2px] -translate-x-1/2 rounded-[1px]" style={{ left: at(mid), backgroundColor: color }} /> : null}
    </div>
  )
}

function Range({ p10, p90 }: { p10?: Fact; p90?: Fact }) {
  if (!p10 || !p90) return null
  return (
    <span className="num block text-[10.5px] leading-tight text-muted" title="10th to 90th percentile">
      <FactChip id={p10.id} show="value" />
      <span className="text-faint">–</span>
      <wbr />
      <FactChip id={p90.id} show="value" />
    </span>
  )
}

function SmokeCell({ day, top }: { day: NextDay; top: number }) {
  const s = day.smoke
  return (
    <td className="min-w-0 px-1.5 py-1 align-top">
      <span className="num block text-[18px] leading-tight text-paper">
        <FactChip id={s.p50?.id} show="value" />
      </span>
      <BandBar p10={s.p10} p50={s.p50} p90={s.p90} top={top} color={chart.model} />
      <Range p10={s.p10} p90={s.p90} />
      <span className="num block truncate text-[10.5px] text-paper-dim">
        <FactChip id={s.ugm3?.id} show="value" />
        {s.beyond ? (
          <span className="ml-0.5 cursor-help text-warn" title={BEYOND}>
            †
          </span>
        ) : null}
      </span>
    </td>
  )
}

function HeatCell({ day, top }: { day: NextDay; top: number }) {
  const h = day.heat
  if (h.extreme && h.p50) {
    return (
      <td className="min-w-0 px-1.5 py-1 align-top">
        <span className="num block text-[18px] leading-tight text-paper">
          <FactChip id={h.p50.id} show="value" />
        </span>
        <BandBar p10={h.p10} p50={h.p50} p90={h.p90} top={top} color={chart.up} />
        <Range p10={h.p10} p90={h.p90} />
        {h.illness ? (
          <span className="block truncate text-[10.5px] text-muted" title="Change in heat illness emergency visits">
            illness <FactChip id={h.illness.id} show="value" className="num text-paper-dim" />
          </span>
        ) : null}
      </td>
    )
  }
  return (
    <td className="min-w-0 px-1.5 py-1 align-top">
      <span className="block truncate text-[14px] leading-tight text-paper-dim" title="NWS HeatRisk category">
        {h.level ? <FactChip id={h.level.id} show="value" /> : <span className="text-faint">no HeatRisk</span>}
      </span>
      <span className="num block truncate text-[10.5px] text-muted" title="Forecast daily high">
        <FactChip id={h.tmax?.id} show="value" />
      </span>
      <span className="block truncate text-[10.5px] text-faint" title="HeatRisk has no published percent change per level, so none is shown">
        category only
      </span>
    </td>
  )
}

function SourceStrip({ view }: { view: NextView }) {
  const n = view.hours.length
  return (
    <div className="border-t border-line/70 px-3 pb-1.5 pt-1">
      <div className="flex flex-wrap items-center justify-between gap-x-2">
        <span className={label}>Hourly smoke</span>
        <span className="flex items-center gap-2.5 text-[11px] text-muted">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2.5 rounded-[1px]" style={{ backgroundColor: SOURCE_COLOR.hrrr }} />
            HRRR-Smoke <span className="num text-paper-dim">{view.counts.hrrr}</span> h
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2.5 rounded-[1px]" style={{ backgroundColor: SOURCE_COLOR.cams }} />
            CAMS <span className="num text-paper-dim">{view.counts.cams}</span> h
          </span>
        </span>
      </div>
      <div className="relative mt-1 flex h-7 items-end gap-px" role="img" aria-label="Hourly smoke, coloured by forecast source">
        {view.hours.map((h: NextHour, i) => {
          const height = h.smoke === null ? 2 : Math.max(2, (h.smoke / view.smokeTop) * 28)
          return (
            <span
              key={h.t || i}
              className="min-w-0 flex-1 rounded-t-[1px]"
              title={`${h.t.slice(5, 16).replace('T', ' ')} UTC · ${h.source.toUpperCase()} · ${h.smoke ?? '—'} µg/m³ smoke${h.past ? ' · past' : ''}`}
              style={{ height, backgroundColor: SOURCE_COLOR[h.source], opacity: h.past ? 0.35 : 0.9 }}
            />
          )
        })}
        {[1, 2].map((k) => (
          <span key={k} className="pointer-events-none absolute inset-y-0 w-px bg-line-strong" style={{ left: `${((k * 24) / Math.max(n, 1)) * 100}%` }} />
        ))}
      </div>
      <div className="mt-0.5 flex justify-between text-[11px] text-faint">
        {view.days.map((d) => (
          <span key={d.day} className="flex-1 truncate">
            {weekday(d.date)}
          </span>
        ))}
      </div>
    </div>
  )
}

function Recommendations({ view }: { view: NextView }) {
  return (
    <div className="border-t border-line/70 px-3 py-1.5">
      <p className={label}>Staffing and stock · rules, not a model</p>
      <ul className="mt-1 space-y-1">
        {view.recs.map((r) => (
          <li key={r.id} className="flex items-start gap-2">
            <Tag tone={CAUSE_TONE[r.cause] ?? 'plain'}>{r.cause === 'none' ? 'all clear' : r.cause}</Tag>
            {r.fact ? (
              <FactHover fact={r.fact} className="min-w-0 cursor-help text-[13px] leading-snug text-paper-dim hover:text-paper">
                {r.text}
              </FactHover>
            ) : (
              <span className="min-w-0 text-[13px] leading-snug text-muted">{r.text}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function NextDays() {
  const view = useNextDays()
  if (!view) {
    return (
      <EmptyState title="ED demand forecast">
        Expected change in emergency visits from wildfire smoke, heat and storms for each of the next three days, with the source of every hour and staffing suggestions.
      </EmptyState>
    )
  }
  return (
    <div className="flex min-h-full flex-col">
      <table className="w-full table-fixed border-collapse text-[13px]">
        <colgroup>
          <col className="w-[66px]" />
          {view.days.map((d) => (
            <col key={d.day} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th className="truncate pb-0.5 pl-3 pr-1 pt-1.5 text-left text-[11px] font-normal text-muted" title={view.label}>
              {view.label}
            </th>
            {view.days.map((d) => (
              <th key={d.day} className="px-1.5 pb-0.5 pt-1.5 text-left font-normal">
                <span className={`${label} block`}>{DAY_WORD[d.day] ?? d.date}</span>
                <span className="block truncate text-[11px] text-muted">{weekday(d.date)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-line/60">
            <th className="py-1 pl-3 pr-1 text-left align-top font-normal">
              <span className="block font-label text-[14px] font-semibold uppercase tracking-[0.06em] text-paper-dim">Smoke</span>
              <span className="block text-[11px] leading-tight text-muted">asthma ED visits</span>
            </th>
            {view.days.map((d) => (
              <SmokeCell key={d.day} day={d} top={view.barTop} />
            ))}
          </tr>
          <tr className="border-t border-line/60">
            <th className="py-1 pl-3 pr-1 text-left align-top font-normal">
              <span className="block font-label text-[14px] font-semibold uppercase tracking-[0.06em] text-paper-dim">Heat</span>
              <span className="block text-[11px] leading-tight text-muted">all ED visits</span>
            </th>
            {view.days.map((d) => (
              <HeatCell key={d.day} day={d} top={view.barTop} />
            ))}
          </tr>
          <tr className="border-t border-line/60">
            <th className="py-1 pl-3 pr-1 text-left align-top font-normal">
              <span className="block font-label text-[14px] font-semibold uppercase tracking-[0.06em] text-paper-dim">Storms</span>
            </th>
            <td colSpan={view.days.length} className="px-1.5 py-1">
              {view.storm.flag ? (
                <span className="flex min-w-0 items-center gap-2">
                  <Tag tone="bad">warning in force</Tag>
                  <span className="truncate text-paper-dim">
                    <FactChip id={view.storm.event?.id} show="value" />
                  </span>
                </span>
              ) : view.storm.warnings ? (
                <span className="text-[12px] text-muted">
                  <FactChip id={view.storm.warnings.id} show="value" className="num" /> severe or extreme NWS warnings here · flag only, no percent
                </span>
              ) : (
                <span className="text-[12px] text-faint">NWS alerts not available here</span>
              )}
            </td>
          </tr>
        </tbody>
      </table>
      <SourceStrip view={view} />
      <Recommendations view={view} />
      <footer className="mt-auto border-t border-line/70 px-3 py-1 text-[11px] leading-snug text-faint">
        {view.fallbacks.map((f) => (
          <span key={f} className="block text-warn">
            {f}
          </span>
        ))}
        {view.days.some((d) => d.smoke.beyond) ? (
          <span className="block truncate">
            <span className="text-warn">†</span> {BEYOND.toLowerCase()}
          </span>
        ) : null}
        <span className="block truncate" title={view.smokeCite ?? undefined}>
          Smoke: {view.smokeCite ?? 'literature term'}
          {view.correctionServed === false ? ' · NYC correction not served (lost on the held-out year)' : ''}
        </span>
        <span className="block truncate" title={view.heatCite ?? undefined}>
          Heat: {view.heatCite ?? 'literature'}, only on days past the local warm-season high
        </span>
      </footer>
    </div>
  )
}
