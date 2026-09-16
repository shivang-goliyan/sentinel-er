import type { FactSource } from '@sentinel/shared'
import type { FactStore } from '../facts/store.ts'
import type { LogChain } from '../log/chain.ts'

export interface Band {
  p10: number
  p50: number
  p90: number
}

export interface EdDemandDay {
  day: number
  date: string
  smoke: {
    ugm3: number
    s01: number
    s23: number
    s45: number
    pct: Band
    hours: { hrrr: number; cams: number }
    beyond_training: boolean
  }
  heat: {
    level: number | null
    level_name: string | null
    tmax_c: number | null
    p95_c: number | null
    extreme: boolean
    evidence: string
    all_cause_pct: Band | null
    heat_illness_pct: Band | null
    renal_pct: Band | null
  }
}

export interface EdDemandHour {
  t: string
  source: 'hrrr' | 'cams' | 'none'
  smoke: number | null
  past: boolean
  pm25?: number
}

export interface EdDemandRec {
  id: number
  cause: 'smoke' | 'heat' | 'storm' | 'none'
  day: number | null
  text: string
  basis: string
}

export interface EdDemand {
  generated_at: string
  location: { lat: number; lon: number; timezone: string }
  days: EdDemandDay[]
  hours: EdDemandHour[]
  lags: { date: string; smoke: number; source: string }[]
  storms: { flag: boolean; active: { event: string; severity: string; headline: string | null; expires: string | null }[]; evidence: string }
  recommendations: EdDemandRec[]
  rules: Record<string, number>
  sources: Record<string, { status: string; url?: string; reason?: string; cycle?: string; hours?: number; p95_c?: number }>
  fallbacks: string[]
  model: {
    smoke: { variant: string; use_correction: boolean; literature: string; background_days: number; training_max_s01: number | null }
    heat: { cite: string; url: string; definition: string }
  }
}

export interface ForecastPoint {
  lat: number
  lon: number
  label: string
}

export interface ForecastDeps {
  chain: LogChain
  facts: FactStore
  scienceUrl: string
  fetch?: typeof fetch
}

const DAY = ['', 'one', 'two', 'three']
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']
const REPO = 'https://github.com/shivang-goliyan/sentinel-er/tree/main/ml/smoke'
const HEATRISK = 'https://www.wpc.ncep.noaa.gov/heatrisk/'
// the HRRR pull alone can take half a minute on a cold cache
const TIMEOUT_MS = 120_000

// read aloud and checked by the verifier, so no digits
const clean = (s: string) => s.replace(/[0-9]+/g, '').replace(/\s{2,}/g, ' ').trim()

const snap = (x: number) => Math.round(x * 50) / 50
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '-' : ''}${Math.abs(v) < 10 ? Math.abs(v).toFixed(1) : Math.round(Math.abs(v))}%`
const spokenPct = (v: number) =>
  v === 0 ? 'no change' : `${v > 0 ? 'up' : 'down'} ${Math.abs(v) < 10 ? Math.abs(v).toFixed(1) : Math.round(Math.abs(v))} percent`

export async function runForecastStage(d: ForecastDeps, runId: string, point: ForecastPoint): Promise<EdDemand | null> {
  const { chain, facts } = d
  const place = clean(point.label) || 'this location'
  const say = (text: string, state: 'working' | 'done' | 'blocked' | 'error' = 'working') => chain.append('analyst', 'status', { text, state }, runId)
  say(`Pulling three days of smoke, heat and storm forecasts for ${place}`)

  let out: EdDemand
  try {
    const res = await (d.fetch ?? fetch)(`${d.scienceUrl}/ed-demand`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // HRRR's grid is 3 km; snapping keeps repeat runs on the science service's cache
      body: JSON.stringify({ lat: snap(point.lat), lon: snap(point.lon) }),
    })
    if (!res.ok) throw new Error(`science service said ${res.status}: ${(await res.text()).slice(0, 200)}`)
    out = (await res.json()) as EdDemand
  } catch (err) {
    const message = (err as Error).message
    chain.append('analyst', 'error', { where: 'ed demand forecast', message }, runId)
    say(`Three-day forecast unavailable: ${message}`, 'error')
    return null
  }

  const at = out.generated_at
  const hrrr = out.sources.hrrr
  const smokeSource: FactSource = {
    name: `Sentinel smoke model (${out.model.smoke.variant}; ${out.model.smoke.literature}; smoke from ${
      hrrr?.status === 'ok' ? 'HRRR-Smoke and CAMS' : 'CAMS only'
    })`,
    url: REPO,
    retrieved_at: at,
    method: 'model',
  }
  const heatRiskSource: FactSource = { name: 'NWS HeatRisk (experimental)', url: HEATRISK, retrieved_at: at, method: 'api' }
  const tempSource: FactSource = { name: 'Open-Meteo forecast', url: 'https://open-meteo.com/en/docs', retrieved_at: at, method: 'api' }
  const heatModel: FactSource = { name: `${out.model.heat.cite}, applied on days at or above the local warm-season high`, url: out.model.heat.url, retrieved_at: at, method: 'model' }
  const rules: FactSource = { name: 'Sentinel staffing rules (thresholds in the forecast log entry)', retrieved_at: at, method: 'computed' }

  const ids: Record<number, Record<string, string>> = {}
  const put = (day: number, field: string, f: Parameters<FactStore['add']>[1]) => {
    const fact = facts.add(runId, f)
    ;(ids[day] ??= {})[field] = fact.id
  }

  for (const day of out.days) {
    const n = DAY[day.day] ?? 'later'
    const k = `forecast.smoke.day${day.day}`
    const pct = day.smoke.pct
    const tag = day.smoke.beyond_training ? ', beyond the smoke levels the model was checked on' : ''
    put(day.day, 'smoke_pct', {
      key: `${k}.pct`,
      label: `Change in asthma emergency visits from smoke on day ${n} at ${place}, middle estimate${tag}`,
      value: pct.p50,
      unit: 'percent',
      display: signed(pct.p50),
      spoken: spokenPct(pct.p50),
      tolerance: { abs: 0.5 },
      source: smokeSource,
    })
    put(day.day, 'smoke_p10', {
      key: `${k}.p10`,
      label: `Change in asthma emergency visits from smoke on day ${n} at ${place}, low estimate`,
      value: pct.p10,
      unit: 'percent',
      display: signed(pct.p10),
      spoken: spokenPct(pct.p10),
      tolerance: { abs: 0.5 },
      source: smokeSource,
    })
    put(day.day, 'smoke_p90', {
      key: `${k}.p90`,
      label: `Change in asthma emergency visits from smoke on day ${n} at ${place}, high estimate`,
      value: pct.p90,
      unit: 'percent',
      display: signed(pct.p90),
      spoken: spokenPct(pct.p90),
      tolerance: { abs: 0.5 },
      source: smokeSource,
    })
    put(day.day, 'smoke_ugm3', {
      key: `${k}.ugm3`,
      label: `Wildfire smoke near the ground on day ${n} at ${place}, daily average`,
      value: day.smoke.ugm3,
      unit: 'ugm3',
      display: `${day.smoke.ugm3.toFixed(day.smoke.ugm3 < 10 ? 1 : 0)} µg/m³`,
      spoken: `${day.smoke.ugm3.toFixed(day.smoke.ugm3 < 10 ? 1 : 0)} micrograms per cubic metre`,
      tolerance: { abs: 0.1 },
      source: hrrr?.status === 'ok'
        ? { name: 'NOAA HRRR-Smoke near-surface smoke, with CAMS past its range', url: 'https://registry.opendata.aws/noaa-hrrr-pds/', retrieved_at: at, method: 'api' }
        : { name: 'CAMS PM2.5 via Open-Meteo, above its own background', url: 'https://open-meteo.com/en/docs/air-quality-api', retrieved_at: at, method: 'api' },
    })

    const h = day.heat
    const hk = `forecast.heat.day${day.day}`
    if (h.level !== null && h.level_name) {
      put(day.day, 'heat_level', {
        key: `${hk}.level`,
        label: `HeatRisk category on day ${n} at ${place}`,
        value: h.level,
        unit: 'count',
        display: `${h.level} · ${h.level_name}`,
        spoken: h.level_name,
        source: heatRiskSource,
      })
    }
    if (h.tmax_c !== null) {
      put(day.day, 'tmax', {
        key: `${hk}.tmax`,
        label: `Forecast high temperature on day ${n} at ${place}`,
        value: h.tmax_c,
        unit: 'celsius',
        display: `${h.tmax_c.toFixed(1)} °C`,
        spoken: `${Math.round(h.tmax_c)} degrees Celsius`,
        tolerance: { abs: 0.5 },
        source: tempSource,
      })
    }
    if (h.extreme && h.all_cause_pct) {
      for (const [q, word] of [['p50', 'middle'], ['p10', 'low'], ['p90', 'high']] as const) {
        put(day.day, `heat_${q}`, {
          key: q === 'p50' ? `${hk}.pct` : `${hk}.${q}`,
          label: `Change in all emergency visits from extreme heat on day ${n} at ${place}, ${word} estimate`,
          value: h.all_cause_pct[q],
          unit: 'percent',
          display: signed(h.all_cause_pct[q]),
          spoken: spokenPct(h.all_cause_pct[q]),
          tolerance: { abs: 0.5 },
          source: heatModel,
        })
      }
      if (h.heat_illness_pct) {
        put(day.day, 'heat_illness', {
          key: `${hk}.heat_illness_pct`,
          label: `Change in heat illness emergency visits on day ${n} at ${place}`,
          value: h.heat_illness_pct.p50,
          unit: 'percent',
          display: signed(h.heat_illness_pct.p50),
          spoken: spokenPct(h.heat_illness_pct.p50),
          tolerance: { abs: 0.5 },
          source: heatModel,
        })
      }
    }
  }

  const first = out.days.find((x) => x.heat.p95_c !== null)
  if (first?.heat.p95_c != null) {
    facts.add(runId, {
      key: 'forecast.heat.threshold',
      label: `Extreme heat line for ${place}, the local warm-season high`,
      value: first.heat.p95_c,
      unit: 'celsius',
      display: `${first.heat.p95_c.toFixed(1)} °C`,
      spoken: `${Math.round(first.heat.p95_c)} degrees Celsius`,
      tolerance: { abs: 0.5 },
      source: { name: 'Open-Meteo archive (ERA5), May to September, used as the local extreme-heat line', url: 'https://open-meteo.com/en/docs/historical-weather-api', retrieved_at: at, method: 'computed' },
    })
  }

  const nws: FactSource = { name: 'NWS active alerts', url: 'https://api.weather.gov/alerts/active', retrieved_at: at, method: 'api' }
  if (out.sources.nws_alerts?.status === 'ok') {
    facts.add(runId, { key: 'forecast.storm.warnings', label: `Severe or extreme weather warnings in force at ${place}`, value: out.storms.active.length, unit: 'count', source: nws })
    const top = out.storms.active[0]
    if (top) facts.add(runId, { key: 'forecast.storm.event', label: `Most serious weather warning at ${place}`, value: clean(top.event), unit: 'text', source: nws })
  }

  const recIds: Record<number, string> = {}
  for (const r of out.recommendations) {
    const word = ORDINALS[r.id - 1]
    const f = facts.add(runId, {
      key: `forecast.recommendation.${r.id}`,
      label: `${word ? `${word[0]!.toUpperCase()}${word.slice(1)}` : 'Further'} recommendation for the next three days at ${place}`,
      value: r.text,
      unit: 'text',
      source: rules,
    })
    recIds[r.id] = f.id
  }

  const hoursBy = { hrrr: 0, cams: 0, none: 0 }
  for (const h of out.hours) hoursBy[h.source]++
  if (hrrr && hrrr.status !== 'ok') {
    chain.append('analyst', 'fallback.used', {
      source: 'hrrr',
      url: 'https://registry.opendata.aws/noaa-hrrr-pds/',
      reason: out.fallbacks.find((x) => x.startsWith('HRRR')) ?? 'HRRR unavailable; CAMS covers every hour',
    }, runId)
  }

  chain.append('analyst', 'model.output', {
    model: 'ed_demand',
    version: out.model.smoke.variant,
    outputs: {
      label: point.label,
      lat: point.lat,
      lon: point.lon,
      timezone: out.location.timezone,
      generated_at: out.generated_at,
      hrrr_cycle: hrrr?.cycle ?? null,
      hours: out.hours.map((h) => ({ t: h.t, source: h.source, smoke: h.smoke, past: h.past })),
      hour_counts: hoursBy,
      days: out.days.map((x) => ({
        day: x.day,
        date: x.date,
        smoke: x.smoke,
        heat: x.heat,
        fact_ids: ids[x.day] ?? {},
      })),
      storms: out.storms,
      recommendations: out.recommendations.map((r) => ({ ...r, fact_id: recIds[r.id] ?? null })),
      rules: out.rules,
      fallbacks: out.fallbacks,
      sources: out.sources,
      heat_evidence: out.model.heat,
      smoke_model: out.model.smoke,
    },
  }, runId)

  const worst = Math.max(...out.days.map((x) => x.smoke.pct.p50))
  const hot = out.days.filter((x) => x.heat.extreme).length
  say(
    `Next three days ready: smoke adds up to ${signed(worst)} asthma visits; ${hot ? `${hot} extreme heat day${hot > 1 ? 's' : ''}` : 'no extreme heat'}${
      out.storms.flag ? '; a severe weather warning is in force' : ''
    }${out.fallbacks.length ? ` (${out.fallbacks.length} fallback${out.fallbacks.length > 1 ? 's' : ''})` : ''}`,
    'done',
  )
  return out
}
