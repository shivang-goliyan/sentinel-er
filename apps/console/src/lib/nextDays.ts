import type { Fact, PayloadOf } from '@sentinel/shared'
import { factRef, type ConsoleState, type Stamped } from '../store/fold'

// The NEXT 72 H panel, picked out of the ed_demand log entry and the forecast.* facts.
// Nothing here makes up a number: values come from facts, the hour strip from the log entry.

type ModelOutput = Stamped<PayloadOf<'model.output'>>
type Source = 'hrrr' | 'cams' | 'none'

export type NextHour = { t: string; source: Source; smoke: number | null; past: boolean }

export type NextDay = {
  day: number
  date: string
  smoke: { p10?: Fact; p50?: Fact; p90?: Fact; ugm3?: Fact; beyond: boolean }
  heat: { level?: Fact; tmax?: Fact; p10?: Fact; p50?: Fact; p90?: Fact; illness?: Fact; extreme: boolean; levelName: string | null }
}

export type NextRec = { id: number; cause: string; day: number | null; fact?: Fact; text: string }

export type NextView = {
  label: string
  cycle: string | null
  timezone: string | null
  days: NextDay[]
  hours: NextHour[]
  counts: Record<Source, number>
  smokeTop: number
  barTop: number
  recs: NextRec[]
  storm: { flag: boolean; warnings?: Fact; event?: Fact }
  fallbacks: string[]
  smokeCite: string | null
  heatCite: string | null
  correctionServed: boolean | null
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const list = (v: unknown) => (Array.isArray(v) ? v : [])

export function nextDaysView(
  s: Pick<ConsoleState, 'facts' | 'latestFactByKey' | 'models'>,
  runId: string | null,
): NextView | null {
  if (!runId) return null
  const entry: ModelOutput | undefined = s.models.findLast((m) => m.run_id === runId && m.model === 'ed_demand')
  if (!entry) return null
  const o = entry.outputs
  const key = (k: string) => {
    const ref = s.latestFactByKey[`${runId}:${k}`]
    return ref ? s.facts[ref] : undefined
  }
  const id = (v: unknown) => (typeof v === 'string' ? s.facts[factRef(runId, v)] : undefined)

  const days: NextDay[] = list(o.days).filter(isObj).map((d) => {
    const n = num(d.day) ?? 0
    const ids = isObj(d.fact_ids) ? d.fact_ids : {}
    const heat = isObj(d.heat) ? d.heat : {}
    const smoke = isObj(d.smoke) ? d.smoke : {}
    return {
      day: n,
      date: str(d.date) ?? '',
      smoke: {
        p10: id(ids.smoke_p10) ?? key(`forecast.smoke.day${n}.p10`),
        p50: id(ids.smoke_pct) ?? key(`forecast.smoke.day${n}.pct`),
        p90: id(ids.smoke_p90) ?? key(`forecast.smoke.day${n}.p90`),
        ugm3: id(ids.smoke_ugm3) ?? key(`forecast.smoke.day${n}.ugm3`),
        beyond: smoke.beyond_training === true,
      },
      heat: {
        level: id(ids.heat_level) ?? key(`forecast.heat.day${n}.level`),
        tmax: id(ids.tmax) ?? key(`forecast.heat.day${n}.tmax`),
        p10: id(ids.heat_p10) ?? key(`forecast.heat.day${n}.p10`),
        p50: id(ids.heat_p50) ?? key(`forecast.heat.day${n}.pct`),
        p90: id(ids.heat_p90) ?? key(`forecast.heat.day${n}.p90`),
        illness: id(ids.heat_illness) ?? key(`forecast.heat.day${n}.heat_illness_pct`),
        extreme: heat.extreme === true,
        levelName: str(heat.level_name) ?? null,
      },
    }
  })

  const hours: NextHour[] = list(o.hours)
    .filter(isObj)
    .map((h) => ({
      t: str(h.t) ?? '',
      source: h.source === 'hrrr' || h.source === 'cams' ? h.source : 'none',
      smoke: num(h.smoke) ?? null,
      past: h.past === true,
    }))
  const counts: Record<Source, number> = { hrrr: 0, cams: 0, none: 0 }
  for (const h of hours) counts[h.source]++

  const values = (f?: Fact) => (f && typeof f.value === 'number' ? f.value : 0)
  const highs = days.flatMap((d) => [values(d.smoke.p90), values(d.heat.p90)])
  const barTop = niceTop(Math.max(10, ...highs))
  const smokeTop = Math.max(1, ...hours.map((h) => h.smoke ?? 0))

  const recs: NextRec[] = list(o.recommendations)
    .filter(isObj)
    .map((r) => {
      const fact = id(r.fact_id) ?? key(`forecast.recommendation.${num(r.id) ?? 0}`)
      return {
        id: num(r.id) ?? 0,
        cause: str(r.cause) ?? 'none',
        day: num(r.day) ?? null,
        fact,
        text: typeof fact?.value === 'string' ? fact.value : str(r.text) ?? '',
      }
    })

  const storms = isObj(o.storms) ? o.storms : {}
  const smokeModel = isObj(o.smoke_model) ? o.smoke_model : {}
  const heatEvidence = isObj(o.heat_evidence) ? o.heat_evidence : {}
  return {
    label: str(o.label) ?? '',
    cycle: str(o.hrrr_cycle) ?? null,
    timezone: str(o.timezone) ?? null,
    days,
    hours,
    counts,
    smokeTop,
    barTop,
    recs,
    storm: { flag: storms.flag === true, warnings: key('forecast.storm.warnings'), event: key('forecast.storm.event') },
    fallbacks: list(o.fallbacks).filter((x): x is string => typeof x === 'string'),
    smokeCite: str(smokeModel.literature) ?? null,
    heatCite: str(heatEvidence.cite) ?? null,
    correctionServed: typeof smokeModel.use_correction === 'boolean' ? smokeModel.use_correction : null,
  }
}

// round a bar scale up to 10, 20, 50, 100…
export function niceTop(x: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(x, 1e-9)))
  for (const m of [1, 2, 5, 10]) if (m * p >= x) return m * p
  return 10 * p
}

// position on a 0..top bar, clamped
export function barPos(v: number, top: number): number {
  return Math.min(1, Math.max(0, v / top))
}

// the date string is already the place's local date, so read it as UTC to keep it
export function weekday(date: string): string {
  const d = new Date(`${date}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return date
  return d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
}
