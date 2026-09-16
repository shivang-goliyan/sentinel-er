// Self-grading: feed a past quake through the crew with only what was known early on, then
// compare with what really happened.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FactSource, HazardEvent } from '@sentinel/shared'
import { repoRoot, type Config } from '../config.ts'
import { callCasualtyModel, localHour, runCasualtyStage, type CasualtyInput, type CasualtyOut } from '../crew/casualty.ts'
import type { FactStore } from '../facts/store.ts'
import type { LogChain } from '../log/chain.ts'

export const SCENARIOS = {
  'turkey-2023': { label: 'Türkiye, 6 February 2023', ownPipeline: false },
  'nepal-2015': { label: 'Nepal, 25 April 2015', ownPipeline: false },
  'mineral-va-2011': { label: 'Mineral, Virginia, 23 August 2011', ownPipeline: true },
} as const
export type Scenario = keyof typeof SCENARIOS

export interface PagerSnapshot {
  scenario: string
  event_id: string
  title: string
  origin_time: string
  final_magnitude: number
  published_at: string
  minutes_after_origin: number
  pager_xml: string
  alert: string | null
  magnitude: number
  depth_km: number
  lat: number
  lon: number
  maxmmi: number
  pop_mmi: Record<string, number>
  iso3: string
  tz: string
}

interface TruthValue {
  value: number | null
  source: string
  url: string
}
export interface Truth {
  scenario: string
  deaths: TruthValue
  injured: TruthValue
  context: { label: string; deaths?: number; injured?: number; url?: string }[]
  note: string
}

const read = <T>(scenario: string, file: string) => JSON.parse(readFileSync(join(repoRoot, 'replay', scenario, file), 'utf8')) as T

// USGS's first PAGER exposure is what a responder had in the first half hour; the final one is
// what the same model would have said with hindsight on the shaking.
export function loadScenario(s: Scenario) {
  return {
    pager: read<PagerSnapshot>(s, 'pager-first.json'),
    final: read<PagerSnapshot>(s, 'pager-final.json'),
    truth: read<Truth>(s, 'truth.json'),
  }
}

export function exposureInput(p: PagerSnapshot): CasualtyInput {
  const popMmi: Record<number, number> = {}
  for (let b = 4; b <= 10; b++) popMmi[b] = p.pop_mmi[String(b)] ?? 0
  return { popMmi, magnitude: p.magnitude, depthKm: p.depth_km, localHour: localHour(p.origin_time, p.tz, p.lon), iso3: p.iso3 }
}

export function rerunEvent(p: PagerSnapshot, ownPipeline: boolean): HazardEvent {
  const now = new Date().toISOString()
  return {
    id: `rerun-${p.event_id}-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`,
    type: 'earthquake',
    title: `RERUN · ${p.title}`,
    tz: p.tz,
    geometry: { type: 'Point', coordinates: [p.lon, p.lat, p.depth_km] },
    severity: {
      mag: ownPipeline ? p.final_magnitude : p.magnitude,
      depth_km: p.depth_km,
      pager_alert: null,
      mmi_max: p.maxmmi,
      origin_time: p.origin_time,
    },
    sources: [{ name: 'USGS', id: p.event_id, url: `https://earthquake.usgs.gov/earthquakes/eventpage/${p.event_id}`, published_at: p.origin_time }],
    detected_at: now,
    ingested_at: now,
    // reruns never call anyone
    tier: 1,
    status: 'active',
    is_drill: false,
  }
}

export interface Grade {
  inside: boolean | null
  median_log10_error: number | null
  planning_log10_error: number | null
}

const logErr = (predicted: number, actual: number) => Math.round(Math.abs(Math.log10(predicted + 1) - Math.log10(actual + 1)) * 100) / 100

export function grade(band: { p10: number; p50: number; p90: number }, planning: number, actual: number | null): Grade {
  if (actual === null) return { inside: null, median_log10_error: null, planning_log10_error: null }
  return {
    inside: band.p10 <= actual && actual <= band.p90,
    median_log10_error: logErr(band.p50, actual),
    planning_log10_error: logErr(planning, actual),
  }
}

const fmt = (n: number) => n.toLocaleString('en-US')

function verdict(g: Grade, band: { p10: number; p90: number }, actual: number | null, planning: number) {
  if (g.inside === null || actual === null) return 'no recorded toll to compare against'
  const range = `${fmt(band.p10)} to ${fmt(band.p90)}`
  const where = g.inside ? 'inside' : actual > band.p90 ? 'above' : 'below'
  if (actual === 0) return `none recorded, ${where} our range of ${range}`
  const ratio = planning > actual ? planning / Math.max(actual, 1) : actual / Math.max(planning, 1)
  const off = ratio < 1.5 ? 'close to it' : `about ${Math.round(ratio)} times ${planning > actual ? 'higher' : 'lower'}`
  return `${fmt(actual)} recorded, ${where} our range of ${range}; the planning figure of ${fmt(planning)} was ${off}`
}

export interface Hindsight {
  out: CasualtyOut
  published_at: string
}

export function recordGrade(
  d: { chain: LogChain; facts: FactStore; sqlite: import('better-sqlite3').Database },
  runId: string,
  truth: Truth,
  out: CasualtyOut,
  planning: 'p50' | 'p90',
  hindsight: Hindsight | null = null,
) {
  const { chain, facts, sqlite } = d
  const now = new Date().toISOString()
  const score = (o: CasualtyOut) => ({
    deaths: grade(o.deaths, o.deaths[planning], truth.deaths.value),
    injured: grade(o.injured, o.injured[planning], truth.injured.value),
  })
  const g = { ...score(out), hindsight: hindsight ? score(hindsight.out) : null }
  const self: FactSource = { name: 'Sentinel self-grading', retrieved_at: now, method: 'computed' }

  for (const target of ['deaths', 'injured'] as const) {
    const t = truth[target]
    const noun = target === 'deaths' ? 'deaths' : 'injuries'
    if (t.value !== null) {
      const source: FactSource = { name: t.source, url: t.url, retrieved_at: now, method: 'dataset' }
      facts.add(runId, { key: `truth.${target}`, label: `Recorded ${noun} afterwards`, value: t.value, unit: 'people', source }, 'verifier')
    }
    if (g[target].inside !== null) {
      facts.add(runId, { key: `grade.${target}.inside`, label: `Recorded ${noun} inside our early range`, value: g[target].inside ? 'yes' : 'no', unit: 'text', source: self }, 'verifier')
    }
    if (hindsight) {
      const source: FactSource = {
        name: `Sentinel casualty model on USGS PAGER's final exposure, published ${hindsight.published_at.slice(0, 10)}`,
        retrieved_at: now,
        method: 'model',
      }
      const label = { p10: 'low', p50: 'middle', p90: 'high' } as const
      for (const q of ['p10', 'p50', 'p90'] as const) {
        facts.add(
          runId,
          {
            key: `hindsight.${target}.${q}`,
            label: `${target === 'deaths' ? 'Deaths' : 'Injured'} with the final shaking estimate, ${label[q]}`,
            value: hindsight.out[target][q],
            unit: 'people',
            source,
          },
          'verifier',
        )
      }
      const h = g.hindsight![target]
      if (h.inside !== null) {
        facts.add(runId, { key: `grade.hindsight.${target}.inside`, label: `Recorded ${noun} inside the hindsight range`, value: h.inside ? 'yes' : 'no', unit: 'text', source: self }, 'verifier')
      }
    }
  }

  sqlite
    .prepare('INSERT OR REPLACE INTO grades (run_id, truth, score, created_at) VALUES (?, ?, ?, ?)')
    .run(runId, JSON.stringify(truth), JSON.stringify(g), now)
  chain.append(
    'verifier',
    'model.output',
    {
      model: 'grade',
      version: 'rerun-2',
      outputs: {
        scenario: truth.scenario,
        truth,
        predicted: { deaths: out.deaths, injured: out.injured, planning },
        hindsight: hindsight ? { deaths: hindsight.out.deaths, injured: hindsight.out.injured, published_at: hindsight.published_at } : null,
        grade: g,
      },
    },
    runId,
  )
  chain.append('verifier', 'status', { text: `Graded deaths: ${verdict(g.deaths, out.deaths, truth.deaths.value, out.deaths[planning])}`, state: 'done' }, runId)
  if (hindsight && g.hindsight) {
    const h = hindsight.out
    chain.append(
      'verifier',
      'status',
      { text: `With USGS's final shaking estimate: ${verdict(g.hindsight.deaths, h.deaths, truth.deaths.value, h.deaths[planning])}`, state: 'done' },
      runId,
    )
  }
  return g
}

// The same model on USGS's settled exposure. Failing here only loses the comparison.
export async function hindsightFor(final: PagerSnapshot, scienceUrl: string): Promise<Hindsight | null> {
  try {
    return { out: await callCasualtyModel(exposureInput(final), scienceUrl), published_at: final.published_at }
  } catch {
    return null
  }
}

// Non-US reruns: USGS's first exposure estimate straight into the casualty model.
export async function rerunFromPager(
  d: { chain: LogChain; facts: FactStore; sqlite: import('better-sqlite3').Database; config: Config },
  runId: string,
  s: Scenario,
) {
  const { chain, facts, config } = d
  const { pager, final, truth } = loadScenario(s)
  const now = new Date().toISOString()
  const pagerSource: FactSource = {
    name: `USGS PAGER, first version, published ${pager.published_at.slice(11, 16)} UTC`,
    url: pager.pager_xml,
    retrieved_at: now,
    method: 'api',
  }
  chain.append('orchestrator', 'status', { text: `Replaying ${SCENARIOS[s].label} with only what USGS had published early on` }, runId)
  facts.add(runId, { key: 'event.magnitude', label: 'Magnitude in the first estimate', value: pager.magnitude, unit: 'magnitude', source: pagerSource }, 'orchestrator')
  facts.add(runId, { key: 'event.depth_km', label: 'Depth in the first estimate', value: pager.depth_km, unit: 'km', display: `${pager.depth_km} km`, source: pagerSource }, 'orchestrator')
  facts.add(runId, { key: 'rerun.minutes_after', label: 'Minutes after the quake that USGS published this exposure', value: pager.minutes_after_origin, unit: 'minutes', source: pagerSource }, 'orchestrator')
  const roman = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']
  const input = exposureInput(pager)
  for (let b = 4; b <= 10; b++) {
    facts.add(runId, { key: `exposure.pop_mmi.${b}`, label: `People exposed to shaking level ${roman[b]}`, value: input.popMmi[b]!, unit: 'people', source: pagerSource }, 'analyst')
  }
  chain.append('orchestrator', 'ledger', { milestone: 'context_built' }, runId)
  chain.append('scout', 'status', { text: 'Hospital, occupancy and power-dependent data are US-only; those layers are skipped here', state: 'blocked' }, runId)

  const out = await runCasualtyStage({ chain, facts }, runId, input, config.SCIENCE_URL, config.CASUALTY_PLANNING)
  if (!out) return null
  chain.append('verifier', 'status', { text: 'Checking the estimate against what was recorded afterwards' }, runId)
  const g = recordGrade(d, runId, truth, out, config.CASUALTY_PLANNING, await hindsightFor(final, config.SCIENCE_URL))
  chain.append('orchestrator', 'run.ended', { status: 'done', note: 'rerun graded' }, runId)
  return g
}
