import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts'
import { utcTime } from '../../lib/format'
import { cardSummary, count, eventName, pct, readCard, type CasualtyCard, type HoldoutRow } from '../../lib/modelCard'
import { chart } from '../../lib/palette'
import { decadeTop, decades, lg, shortCount } from '../../lib/scale'
import { casualtyView } from '../../store/views'
import { useConsole } from '../../store/stream'
import { EmptyState, FactChip, Tag } from '../ui'

let pending: Promise<CasualtyCard> | null = null

function loadCard(): Promise<CasualtyCard> {
  pending ??= fetch('/api/models/casualty')
    .then(async (res) => {
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `The server said ${res.status}.`)
      const card = readCard(body)
      if (!card) throw new Error('The model card came back in a shape the console does not know.')
      return card
    })
    .catch((err: unknown) => {
      pending = null
      throw err
    })
  return pending
}

type Load = { card: CasualtyCard } | { error: string } | null

function useCard(): Load {
  const [state, setState] = useState<Load>(null)
  useEffect(() => {
    let live = true
    loadCard().then(
      (card) => live && setState({ card }),
      (err: unknown) => live && setState({ error: err instanceof Error ? err.message : 'Could not load the model card.' }),
    )
    return () => {
      live = false
    }
  }, [])
  return state
}

const axisTick = { fill: chart.muted, fontSize: 12, fontFamily: 'Red Hat Mono Variable, monospace' }
const unlg = (v: number) => shortCount(Math.max(0, Math.round(10 ** v - 1)))

function Card({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-line px-5 py-4">
      <h3 className="panel-head">{title}</h3>
      {note ? <p className="mt-0.5 text-[13px] leading-snug text-muted">{note}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  )
}

function Key({ mark, children }: { mark: ReactNode; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-paper-dim">
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
        {mark}
      </svg>
      {children}
    </span>
  )
}

function Tip({ children }: { children: ReactNode }) {
  return <div className="rounded-[3px] border border-line-strong bg-ink-750 px-3 py-2 text-[12px] text-paper-dim shadow-lg">{children}</div>
}

type Pt = { x: number; y: number; row: HoldoutRow }

const diamond = (cx: number, cy: number, r: number) => `M${cx},${cy - r}L${cx + r},${cy}L${cx},${cy + r}L${cx - r},${cy}Z`
const triangle = (cx: number, cy: number, r: number) => `M${cx},${cy - r}L${cx + r},${cy + r * 0.8}L${cx - r},${cy + r * 0.8}Z`

type ShapeProps = { cx?: number; cy?: number }

function HoldoutChart({ rows }: { rows: HoldoutRow[] }) {
  const top = decadeTop(Math.max(...rows.flatMap((r) => [r.p90, r.ncei ?? 0, r.official ?? 0, r.pager_baseline ?? 0])))
  // start the axis at the decade under the smallest value so the ticks don't bunch up at zero
  const low = Math.min(...rows.map((r) => r.p10))
  const bottom = low >= 10 ? 10 ** Math.floor(Math.log10(low)) : 0
  const ticks = decades(top).filter((d) => d >= bottom).map(lg)
  const label = (r: HoldoutRow) => `${eventName(r.event)} · ${r.target}`
  const pts = (pick: (r: HoldoutRow) => number | null): Pt[] =>
    rows.flatMap((r, i) => {
      const v = pick(r)
      return v === null ? [] : [{ x: lg(v), y: i, row: r }]
    })
  const bandH = 0.2

  return (
    <>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1">
        <Key mark={<rect x="1" y="4" width="12" height="6" fill={chart.model} fillOpacity="0.3" stroke={chart.model} />}>model 10th–90th percentile</Key>
        <Key mark={<rect x="6" y="1" width="2.5" height="12" fill={chart.model} />}>model median</Key>
        <Key mark={<path d={diamond(7, 7, 5)} fill={chart.ink} />}>recorded (NOAA NCEI)</Key>
        <Key mark={<circle cx="7" cy="7" r="4" fill="none" stroke={chart.ink} strokeWidth="1.5" />}>official count</Key>
        <Key mark={<path d={triangle(7, 7, 5)} fill={chart.other} />}>USGS PAGER estimate</Key>
      </div>
      <ResponsiveContainer width="100%" height={rows.length * 46 + 40}>
        <ScatterChart margin={{ top: 6, right: 18, bottom: 4, left: 4 }}>
          <CartesianGrid horizontal={false} stroke={chart.grid} />
          <XAxis
            type="number"
            dataKey="x"
            domain={[lg(bottom), lg(top)]}
            ticks={ticks}
            tickFormatter={unlg}
            tick={axisTick}
            stroke={chart.axis}
            allowDataOverflow
          />
          <YAxis
            type="number"
            dataKey="y"
            domain={[-0.5, rows.length - 0.5]}
            ticks={rows.map((_, i) => i)}
            tickFormatter={(i: number) => (rows[i] ? label(rows[i]) : '')}
            reversed
            width={168}
            tick={{ ...axisTick, fill: chart.inkDim, fontFamily: 'Public Sans Variable, sans-serif', fontSize: 13 }}
            stroke={chart.axis}
            tickLine={false}
          />
          <ZAxis range={[90, 90]} />
          {rows.map((r, i) => (
            <ReferenceArea
              key={`${r.event}-${r.target}`}
              x1={lg(r.p10)}
              x2={lg(r.p90)}
              y1={i - bandH}
              y2={i + bandH}
              fill={chart.model}
              fillOpacity={0.28}
              stroke={chart.model}
              strokeOpacity={0.9}
              ifOverflow="hidden"
            />
          ))}
          <Tooltip
            cursor={false}
            content={({ active, payload }) => {
              const p = active ? (payload?.[0]?.payload as Pt | undefined) : undefined
              if (!p) return null
              const r = p.row
              return (
                <Tip>
                  <p className="text-paper">{label(r)}</p>
                  <p className="num">
                    band {count(r.p10)}–{count(r.p90)} · median {count(r.p50)}
                  </p>
                  {r.ncei !== null ? <p className="num">recorded {count(r.ncei)}</p> : null}
                  {r.official !== null ? <p className="num">official {count(r.official)}</p> : null}
                  {r.pager_baseline !== null ? <p className="num">PAGER {count(r.pager_baseline)}</p> : null}
                </Tip>
              )
            }}
          />
          <Scatter
            data={pts((r) => r.p50)}
            isAnimationActive={false}
            shape={({ cx = 0, cy = 0 }: ShapeProps) => <rect x={cx - 1.5} y={cy - 12} width={3} height={24} fill={chart.model} />}
          />
          <Scatter
            data={pts((r) => r.official)}
            isAnimationActive={false}
            shape={({ cx = 0, cy = 0 }: ShapeProps) => <circle cx={cx} cy={cy} r={6} fill="none" stroke={chart.ink} strokeWidth={1.5} />}
          />
          <Scatter
            data={pts((r) => r.ncei)}
            isAnimationActive={false}
            shape={({ cx = 0, cy = 0 }: ShapeProps) => <path d={diamond(cx, cy, 6)} fill={chart.ink} stroke={chart.surface} strokeWidth={1.5} />}
          />
          <Scatter
            data={pts((r) => r.pager_baseline)}
            isAnimationActive={false}
            shape={({ cx = 0, cy = 0 }: ShapeProps) => <path d={triangle(cx, cy - 11, 5.5)} fill={chart.other} stroke={chart.surface} strokeWidth={1.5} />}
          />
        </ScatterChart>
      </ResponsiveContainer>
      <table className="mt-2 w-full table-fixed border-collapse text-[13px]">
        <thead>
          <tr className="whitespace-nowrap text-left font-label text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">
            <th className="py-1 font-semibold">Held out</th>
            <th className="w-[24%] py-1 text-right font-semibold">Model band</th>
            <th className="w-[12%] py-1 text-right font-semibold">Median</th>
            <th className="w-[14%] py-1 text-right font-semibold">Recorded</th>
            <th className="w-[13%] py-1 pl-2 font-semibold" />
            <th className="w-[11%] py-1 text-right font-semibold">PAGER</th>
          </tr>
        </thead>
        <tbody className="num">
          {rows.map((r) => {
            const inside = r.ncei !== null && r.ncei >= r.p10 && r.ncei <= r.p90
            return (
              <tr key={`${r.event}-${r.target}`} className="border-t border-line/60">
                <td className="py-1 font-sans text-paper-dim">{label(r)}</td>
                <td className="py-1 text-right text-paper-dim">
                  {count(r.p10)}–{count(r.p90)}
                </td>
                <td className="py-1 text-right text-paper-dim">{count(r.p50)}</td>
                <td className="py-1 text-right text-paper">{r.ncei !== null ? count(r.ncei) : '—'}</td>
                <td className="py-1 pl-2">
                  {r.ncei !== null ? <Tag tone={inside ? 'good' : 'warn'}>{inside ? 'in band' : 'outside'}</Tag> : null}
                </td>
                <td className="py-1 text-right text-muted">{r.pager_baseline !== null ? count(r.pager_baseline) : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}

type CalPt = { x: number; y: number; id: string; deaths: number; p10: number; p50: number; p90: number }

function CalibrationChart({ card }: { card: CasualtyCard }) {
  const { inside, outside, top } = useMemo(() => {
    const inside: CalPt[] = []
    const outside: CalPt[] = []
    let max = 10
    for (const p of card.calibration) {
      const pt = { x: lg(p.deaths), y: lg(p.pred_p50), id: p.event_id, deaths: p.deaths, p10: p.pred_p10, p50: p.pred_p50, p90: p.pred_p90 }
      ;(p.deaths >= p.pred_p10 && p.deaths <= p.pred_p90 ? inside : outside).push(pt)
      max = Math.max(max, p.deaths, p.pred_p50)
    }
    return { inside, outside, top: decadeTop(max) }
  }, [card])
  const ticks = decades(top).map(lg)
  const dot = (fill: string) =>
    function Dot({ cx = 0, cy = 0 }: ShapeProps) {
      return <circle cx={cx} cy={cy} r={3.2} fill={fill} fillOpacity={0.75} stroke={chart.surface} strokeWidth={0.8} />
    }

  return (
    <>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1">
        <Key mark={<circle cx="7" cy="7" r="4" fill={chart.model} />}>recorded deaths inside the band</Key>
        <Key mark={<circle cx="7" cy="7" r="4" fill={chart.other} />}>outside the band</Key>
        <Key mark={<line x1="1" y1="13" x2="13" y2="1" stroke={chart.muted} strokeWidth="1.5" />}>perfect median</Key>
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <ScatterChart margin={{ top: 6, right: 18, bottom: 22, left: 8 }}>
          <CartesianGrid stroke={chart.grid} />
          <XAxis
            type="number"
            dataKey="x"
            domain={[0, lg(top)]}
            ticks={ticks}
            tickFormatter={unlg}
            tick={axisTick}
            stroke={chart.axis}
            label={{ value: 'recorded deaths', position: 'insideBottom', offset: -14, fill: chart.muted, fontSize: 12 }}
          />
          <YAxis
            type="number"
            dataKey="y"
            domain={[0, lg(top)]}
            ticks={ticks}
            tickFormatter={unlg}
            tick={axisTick}
            stroke={chart.axis}
            width={52}
            label={{ value: 'predicted median', angle: -90, position: 'insideLeft', offset: 6, fill: chart.muted, fontSize: 12 }}
          />
          <ReferenceLine
            segment={[
              { x: 0, y: 0 },
              { x: lg(top), y: lg(top) },
            ]}
            stroke={chart.muted}
            strokeWidth={1.5}
          />
          <Tooltip
            cursor={false}
            content={({ active, payload }) => {
              const p = active ? (payload?.[0]?.payload as CalPt | undefined) : undefined
              if (!p) return null
              return (
                <Tip>
                  <p className="text-paper">{p.id}</p>
                  <p className="num">recorded {count(p.deaths)}</p>
                  <p className="num">
                    median {count(p.p50)} · band {count(p.p10)}–{count(p.p90)}
                  </p>
                </Tip>
              )
            }}
          />
          <Scatter data={inside} isAnimationActive={false} shape={dot(chart.model)} />
          <Scatter data={outside} isAnimationActive={false} shape={dot(chart.other)} />
        </ScatterChart>
      </ResponsiveContainer>
    </>
  )
}

const SHORT: Record<string, string> = { 'Lower-middle': 'Lower mid', 'Upper-middle': 'Upper mid' }

function ClassTick({ x = 0, y = 0, payload, sub }: { x?: number; y?: number; payload?: { value: string }; sub: Record<string, number> }) {
  const name = payload?.value ?? ''
  return (
    <g transform={`translate(${x},${y})`}>
      <text dy={14} textAnchor="middle" fill={chart.inkDim} fontSize={13} fontFamily="Public Sans Variable, sans-serif">
        {SHORT[name] ?? name}
      </text>
      {sub[name] !== undefined ? (
        <text dy={30} textAnchor="middle" fill={chart.faint} fontSize={12} fontFamily="Red Hat Mono Variable, monospace">
          {sub[name]}
        </text>
      ) : null}
    </g>
  )
}

type BarLabel = { x?: number | string; y?: number | string; width?: number | string; height?: number | string; value?: unknown }

// under the end of a bar that hangs below zero
function GapLabel({ x = 0, y = 0, width = 0, height = 0, value }: BarLabel) {
  if (typeof value !== 'number') return null
  const [bx, by, bw, bh] = [Number(x), Number(y), Number(width), Number(height)]
  return (
    <text x={bx + bw / 2} y={Math.max(by, by + bh) + 15} textAnchor="middle" fill={chart.ink} fontSize={12} fontFamily="Red Hat Mono Variable, monospace">
      {value.toFixed(2)}
    </text>
  )
}

function steps(from: number, to: number, by: number): number[] {
  const out: number[] = []
  for (let v = to; v >= from - 1e-9; v -= by) out.push(Math.round(v * 100) / 100)
  return out
}

function BiasCharts({ card }: { card: CasualtyCard }) {
  const data = card.bias.map(({ name, group }) => ({
    name,
    cover: group.coverage_deadly,
    gap: group.median_residual_log10_deadly,
  }))
  const sub = Object.fromEntries(card.bias.map(({ name, group }) => [name, group.rows_with_deaths]))
  const lowest = Math.min(0, ...data.map((d) => d.gap ?? 0))
  const floor = Math.floor((lowest - 0.12) * 5) / 5
  const tick = (props: object) => <ClassTick {...props} sub={sub} />

  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <p className="text-[13px] text-paper-dim">Band held the recorded deaths</p>
        <ResponsiveContainer width="100%" height={190}>
          <BarChart data={data} margin={{ top: 18, right: 4, bottom: 4, left: -18 }} barCategoryGap="28%">
            <CartesianGrid vertical={false} stroke={chart.grid} />
            <XAxis dataKey="name" tick={tick} height={40} interval={0} stroke={chart.axis} tickLine={false} />
            <YAxis domain={[0, 1]} ticks={[0, 0.5, 1]} tickFormatter={pct} tick={axisTick} stroke={chart.axis} />
            <Bar dataKey="cover" fill={chart.model} radius={[4, 4, 0, 0]} isAnimationActive={false}>
              <LabelList dataKey="cover" position="top" formatter={(v: unknown) => (typeof v === 'number' ? pct(v) : '')} fill={chart.ink} fontSize={12} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div>
        <p className="text-[13px] text-paper-dim">Median gap, log10 (below 0 = too low)</p>
        <ResponsiveContainer width="100%" height={190}>
          <BarChart data={data} margin={{ top: 18, right: 4, bottom: 4, left: -18 }} barCategoryGap="28%">
            <CartesianGrid vertical={false} stroke={chart.grid} />
            <XAxis dataKey="name" tick={tick} height={40} interval={0} stroke={chart.axis} tickLine={false} />
            <YAxis domain={[floor, 0]} ticks={steps(floor, 0, 0.2)} tickFormatter={(v: number) => v.toFixed(1)} tick={axisTick} stroke={chart.axis} />
            <ReferenceLine y={0} stroke={chart.muted} />
            <Bar dataKey="gap" fill={chart.other} radius={[0, 0, 4, 4]} isAnimationActive={false}>
              <LabelList dataKey="gap" content={(p) => <GapLabel {...(p as BarLabel)} />} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function RunContributions() {
  const facts = useConsole((s) => s.view.facts)
  const latestFactByKey = useConsole((s) => s.view.latestFactByKey)
  const models = useConsole((s) => s.view.models)
  const runId = useConsole((s) => s.view.activeRunId)
  const view = useMemo(() => casualtyView({ facts, latestFactByKey, models }, runId, 8), [facts, latestFactByKey, models, runId])

  if (!view || !view.contributions.length) {
    return <p className="text-[13px] text-muted">No casualty estimate in the current run yet.</p>
  }
  const data = view.contributions.map((c) => ({ ...c }))
  const widest = Math.max(...data.map((d) => Math.abs(d.value)))
  const unit = widest > 0.6 ? 0.5 : widest > 0.3 ? 0.25 : 0.1
  const edge = Math.ceil((widest * 1.05) / unit) * unit

  return (
    <>
      <p className="text-[13px] text-paper-dim">
        {view.priorDeaths !== null ? (
          <>
            Starts from a physical estimate of <span className="num text-paper">{view.priorDeaths.toLocaleString('en-US')}</span> deaths;
            these features move the median to{' '}
          </>
        ) : (
          'These features set the median at '
        )}
        <span className="num text-paper">
          <FactChip id={view.deaths.p50?.id} show="value" />
        </span>
        .
      </p>
      <ResponsiveContainer width="100%" height={data.length * 30 + 36}>
        <BarChart data={data} layout="vertical" margin={{ top: 8, right: 18, bottom: 4, left: 4 }} barCategoryGap="22%">
          <CartesianGrid horizontal={false} stroke={chart.grid} />
          <XAxis
            type="number"
            domain={[-edge, edge]}
            ticks={steps(-edge, edge, unit)}
            tickFormatter={(v: number) => (v === 0 ? '0' : v.toFixed(unit < 0.5 ? 2 : 1))}
            tick={axisTick}
            stroke={chart.axis}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={210}
            tick={{ ...axisTick, fill: chart.inkDim, fontFamily: 'Public Sans Variable, sans-serif', fontSize: 13 }}
            stroke={chart.axis}
            tickLine={false}
          />
          <ReferenceLine x={0} stroke={chart.muted} />
          <Tooltip
            cursor={{ fill: 'rgb(255 255 255 / 0.04)' }}
            content={({ active, payload }) => {
              const d = active ? (payload?.[0]?.payload as (typeof data)[number] | undefined) : undefined
              if (!d) return null
              return (
                <Tip>
                  <p className="text-paper">{d.name}</p>
                  <p>
                    {d.value > 0 ? 'raised' : 'lowered'} the median by <span className="num">{Math.abs(d.value).toFixed(2)}</span> on the log scale
                  </p>
                </Tip>
              )
            }}
          />
          <Bar dataKey="value" isAnimationActive={false} radius={2}>
            {data.map((d) => (
              <Cell key={d.feature} fill={d.value > 0 ? chart.up : chart.down} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="mt-1 flex gap-4">
        <Key mark={<rect x="1" y="3" width="12" height="8" rx="1" fill={chart.up} />}>raised the estimate</Key>
        <Key mark={<rect x="1" y="3" width="12" height="8" rx="1" fill={chart.down} />}>lowered it</Key>
        <span className="ml-auto text-[12px] text-faint">change on the log scale the model predicts in</span>
      </div>
    </>
  )
}

export function ModelsBody() {
  const load = useCard()
  const models = useConsole((s) => s.view.models)
  const runId = useConsole((s) => s.view.activeRunId)
  const summary = useMemo(() => (load && 'card' in load ? cardSummary(load.card) : []), [load])
  const runModels = useMemo(() => models.filter((m) => m.run_id === runId).reverse(), [models, runId])

  if (!load) return <EmptyState title="Loading the casualty model card" />
  if ('error' in load) {
    return (
      <EmptyState title="Model card unavailable">
        {load.error} The estimates on the main screen still carry their sources.
      </EmptyState>
    )
  }
  const { card } = load

  return (
    <>
      <section className="border-b border-line px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-label text-[20px] font-bold uppercase tracking-[0.1em] text-paper">Casualty model</h3>
          <Tag tone="warn">screening estimate</Tag>
          {card.variant ? <Tag tone="quiet">{card.variant.replace(/_/g, ' ')}</Tag> : null}
        </div>
        <p className="mt-0.5 text-[13px] text-muted">Gradient-boosted quantiles on a physical prior, trained on USGS PAGER exposure and NOAA NCEI death records.</p>
        {summary.length ? (
          <div className="mt-3 space-y-1.5 border-l-2 border-warn/70 pl-3 text-[14px] leading-relaxed text-paper">
            {summary.map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          </div>
        ) : null}
      </section>

      {card.holdout.length ? (
        <Card
          title="Held-out quakes"
          note={`${[...new Set(card.holdout.map((r) => eventName(r.event)))].join(' and ')} were kept out of training. Log scale.`}
        >
          <HoldoutChart rows={card.holdout} />
        </Card>
      ) : null}

      {card.calibration.length ? (
        <Card
          title="Calibration"
          note={`Out-of-fold medians for ${count(card.calibration.length)} deadly quakes, each predicted by a model that never saw it. Above the line the median ran high, below it ran low.`}
        >
          <CalibrationChart card={card} />
        </Card>
      ) : null}

      {card.bias.length ? (
        <Card
          title="Bias by country income"
          note="Deadly quakes only, grouped by World Bank income class; the small number under each class is how many. A gap of −0.3 means the median came in at about half the recorded deaths."
        >
          <BiasCharts card={card} />
        </Card>
      ) : null}

      <Card title="This run" note="What moved the death estimate for the incident on screen.">
        <RunContributions />
      </Card>

      {runModels.length ? (
        <section className="px-5 py-4">
          <h3 className="panel-head mb-2">Model outputs in this run</h3>
          <ul className="space-y-1 text-[13px]">
            {runModels.map((m) => (
              <li key={m.seq} className="flex items-center gap-2">
                <span className="text-paper-dim">{m.model}</span>
                <span className="num text-faint">{m.version}</span>
                <span className="num ml-auto text-[12px] text-faint">{utcTime(m.ts)} UTC</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  )
}
