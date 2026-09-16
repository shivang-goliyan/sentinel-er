import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runForecastStage, type EdDemand } from '../src/crew/forecast.ts'
import { PASS, makeApp, makeDeps } from './helpers.ts'

const band = (p10: number, p50: number, p90: number) => ({ p10, p50, p90 })

function sample(opts: { hrrr?: 'ok' | 'failed'; hot?: boolean; smoke?: number } = {}): EdDemand {
  const hrrr = opts.hrrr ?? 'ok'
  const smoke = opts.smoke ?? 22
  const hours = Array.from({ length: 72 }, (_, h) => ({
    t: new Date(Date.UTC(2026, 8, 16, 4 + h)).toISOString(),
    source: (hrrr === 'ok' && h >= 2 && h < 51 ? 'hrrr' : 'cams') as 'hrrr' | 'cams',
    smoke: h > 30 && h < 40 ? smoke : 0.4,
    past: h < 9,
  }))
  const day = (n: number, pct: number) => ({
    day: n,
    date: `2026-09-${15 + n}`,
    smoke: { ugm3: n === 2 ? smoke : 0.4, s01: 3, s23: 0, s45: 0, pct: band(pct / 2, pct, pct * 1.5), hours: { hrrr: 20, cams: 4 }, beyond_training: n === 2 && smoke > 34 },
    heat: {
      level: n === 1 && opts.hot ? 3 : 1,
      level_name: n === 1 && opts.hot ? 'major' : 'minor',
      tmax_c: n === 1 && opts.hot ? 36.2 : 29.9,
      p95_c: 34.6,
      extreme: n === 1 && !!opts.hot,
      evidence: n === 1 && opts.hot ? 'literature' : 'category only',
      all_cause_pct: n === 1 && opts.hot ? band(7.5, 7.8, 8.1) : null,
      heat_illness_pct: n === 1 && opts.hot ? band(62.6, 66.3, 70) : null,
      renal_pct: null,
    },
  })
  return {
    generated_at: '2026-09-16T13:30:00+00:00',
    location: { lat: 38.8, lon: -77.06, timezone: 'America/New_York' },
    days: [day(1, 0.4), day(2, 12.6), day(3, 3.1)],
    hours,
    lags: [],
    storms: { flag: true, active: [{ event: 'Severe Thunderstorm Warning', severity: 'Severe', headline: 'until 5 PM', expires: null }], evidence: 'flag only' },
    recommendations: [
      { id: 1, cause: 'smoke', day: 2, text: 'Add respiratory therapist hours on day two for smoke-driven asthma visits', basis: 'x' },
      { id: 2, cause: 'smoke', day: 2, text: 'Check nebuliser, spacer and rescue inhaler stock before day two', basis: 'x' },
      { id: 3, cause: 'storm', day: null, text: 'Severe weather warning in force: check generator fuel and expect injury and outage patients', basis: 'x' },
      { id: 4, cause: 'heat', day: 1, text: 'Stage extra cooling on day one: ice, cold fluids, cooling blankets', basis: 'x' },
    ],
    rules: { rt_extra_p50: 10 },
    sources: {
      hrrr: hrrr === 'ok' ? { status: 'ok', cycle: '2026-09-16T06:00:00+00:00', hours: 49 } : { status: 'failed', reason: 'bucket said no' },
      cams: { status: 'ok' },
      nws_alerts: { status: 'ok' },
    },
    fallbacks: hrrr === 'ok' ? [] : ['HRRR failed (bucket said no); CAMS covers every hour'],
    model: {
      smoke: { variant: 'smoke-nyc-log-all-literature', use_correction: false, literature: 'Gan RW et al. 2020', background_days: 30, training_max_s01: 34.2 },
      heat: { cite: 'Sun S et al. BMJ 2021', url: 'https://doi.org/10.1136/bmj-2021-065653', definition: 'p95' },
    },
  }
}

const fakeFetch = (body: unknown, status = 200, seen: string[] = []) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(`${String(url)} ${String(init?.body)}`)
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

describe('forecast stage', () => {
  it('writes day facts in order', async () => {
    const d = makeDeps()
    const seen: string[] = []
    const out = await runForecastStage({ ...d, scienceUrl: 'http://science', fetch: fakeFetch(sample(), 200, seen) }, 'r1', { lat: 38.8048, lon: -77.0469, label: 'Inova Alexandria' })
    expect(out).not.toBeNull()
    expect(seen[0]).toBe('http://science/ed-demand {"lat":38.8,"lon":-77.04}')
    const facts = Object.fromEntries(d.facts.latest('r1').map((f) => [f.key, f]))
    expect(facts['forecast.smoke.day2.pct']!.value).toBe(12.6)
    expect(facts['forecast.smoke.day2.pct']!.display).toBe('+13%')
    expect(facts['forecast.smoke.day2.p10']!.value).toBe(6.3)
    expect(facts['forecast.smoke.day1.pct']!.display).toBe('+0.4%')
    expect(facts['forecast.smoke.day1.pct']!.spoken).toBe('up 0.4 percent')
    expect(facts['forecast.heat.day1.level']!.spoken).toBe('minor')
    expect(facts['forecast.recommendation.1']!.value).toContain('respiratory therapist')
    expect(facts['forecast.storm.warnings']!.value).toBe(1)
    expect(facts['forecast.heat.day1.pct']).toBeUndefined()
  })

  it('labels never carry digits', async () => {
    const d = makeDeps()
    await runForecastStage({ ...d, scienceUrl: 'http://s', fetch: fakeFetch(sample({ hot: true, smoke: 60 })) }, 'r2', { lat: 38.8, lon: -77, label: 'Inova Alexandria 22314' })
    const facts = d.facts.latest('r2')
    expect(facts.length).toBeGreaterThan(15)
    for (const f of facts) expect(f.label, f.key).not.toMatch(/\d/)
    expect(facts.find((f) => f.key === 'forecast.smoke.day2.pct')!.label).toContain('day two')
    expect(facts.find((f) => f.key === 'forecast.smoke.day2.pct')!.label).toContain('beyond the smoke levels')
  })

  it('adds heat percent when extreme', async () => {
    const d = makeDeps()
    await runForecastStage({ ...d, scienceUrl: 'http://s', fetch: fakeFetch(sample({ hot: true })) }, 'r3', { lat: 38.8, lon: -77, label: 'here' })
    const byKey = (k: string) => d.facts.byKey('r3', k)
    expect(byKey('forecast.heat.day1.pct')!.value).toBe(7.8)
    expect(byKey('forecast.heat.day1.p90')!.value).toBe(8.1)
    expect(byKey('forecast.heat.day1.heat_illness_pct')!.display).toBe('+66%')
    expect(byKey('forecast.heat.day1.tmax')!.display).toBe('36.2 °C')
    expect(byKey('forecast.heat.threshold')!.value).toBe(34.6)
  })

  it('logs the hour strip', async () => {
    const d = makeDeps()
    await runForecastStage({ ...d, scienceUrl: 'http://s', fetch: fakeFetch(sample()) }, 'r4', { lat: 38.8, lon: -77, label: 'here' })
    const entry = d.chain.after(0, 500).find((e) => e.kind === 'model.output')
    expect(entry?.kind).toBe('model.output')
    if (entry?.kind !== 'model.output') return
    expect(entry.payload.model).toBe('ed_demand')
    const o = entry.payload.outputs as { hours: unknown[]; hour_counts: Record<string, number>; days: { fact_ids: Record<string, string> }[]; recommendations: { fact_id: string }[] }
    expect(o.hours).toHaveLength(72)
    expect(o.hour_counts).toEqual({ hrrr: 49, cams: 23, none: 0 })
    const id = o.days[1]!.fact_ids.smoke_pct!
    expect(d.facts.get('r4', id)!.key).toBe('forecast.smoke.day2.pct')
    expect(d.facts.get('r4', o.recommendations[0]!.fact_id)!.key).toBe('forecast.recommendation.1')
    expect(d.chain.verify().ok).toBe(true)
  })

  it('logs the HRRR fallback', async () => {
    const d = makeDeps()
    await runForecastStage({ ...d, scienceUrl: 'http://s', fetch: fakeFetch(sample({ hrrr: 'failed' })) }, 'r5', { lat: 38.8, lon: -77, label: 'here' })
    const fb = d.chain.after(0, 500).find((e) => e.kind === 'fallback.used')
    expect(fb?.payload).toMatchObject({ source: 'hrrr', reason: 'HRRR failed (bucket said no); CAMS covers every hour' })
    expect(d.facts.byKey('r5', 'forecast.smoke.day1.ugm3')!.source.name).toContain('CAMS')
  })

  it('reports a science failure', async () => {
    const d = makeDeps()
    const out = await runForecastStage({ ...d, scienceUrl: 'http://s', fetch: fakeFetch({ detail: 'upstream down' }, 502) }, 'r6', { lat: 38.8, lon: -77, label: 'here' })
    expect(out).toBeNull()
    const last = d.chain.after(0, 50).at(-1)!
    expect(last.kind).toBe('status')
    expect(last.payload).toMatchObject({ state: 'error' })
    expect(d.facts.latest('r6')).toEqual([])
  })
})

let science: Server
let url = ''
beforeAll(async () => {
  science = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(sample()))
    })
  })
  await new Promise<void>((r) => science.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(science.address() as AddressInfo).port}`
})
afterAll(() => science.close())

describe('forecast route', () => {
  it('needs the operator', async () => {
    const { app } = await makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/forecast', payload: { lat: 38.8, lon: -77, label: 'x' } })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('rejects a missing label', async () => {
    const { app } = await makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/forecast', headers: { 'x-operator': PASS }, payload: { lat: 38.8, lon: -77 } })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('runs a light forecast run', async () => {
    const a = await makeApp({ SCIENCE_URL: url })
    const res = await a.app.inject({ method: 'POST', url: '/api/forecast', headers: { 'x-operator': PASS }, payload: { lat: 38.8, lon: -77.06, label: 'Inova Alexandria' } })
    expect(res.statusCode).toBe(202)
    const { run_id: runId } = res.json() as { run_id: string }
    const deadline = Date.now() + 5000
    while (!a.chain.after(0, 5000).some((e) => e.run_id === runId && e.kind === 'run.ended') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
    const entries = a.chain.after(0, 5000).filter((e) => e.run_id === runId)
    const started = entries.find((e) => e.kind === 'run.started')
    expect(started?.payload).toMatchObject({ mode: 'any_hospital', title: 'Next three days · Inova Alexandria' })
    expect(entries.find((e) => e.kind === 'run.ended')?.payload).toMatchObject({ status: 'done' })
    expect(a.facts.byKey(runId, 'forecast.smoke.day2.pct')?.value).toBe(12.6)
    expect(entries.some((e) => e.kind === 'fact' && e.payload.fact.key.startsWith('exposure.'))).toBe(false)
    await a.app.close()
  })
})
