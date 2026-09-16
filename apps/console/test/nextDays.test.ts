import { describe, expect, it } from 'vitest'
import { LogEntry, type LogEntry as Entry } from '@sentinel/shared'
import { foldAll } from '../src/store/fold'
import { barPos, nextDaysView, niceTop, weekday } from '../src/lib/nextDays'

const HASH = 'c'.repeat(64)
const RUN = 'run-f'
let seq = 0

function entry(kind: string, payload: unknown, run: string | null = RUN): Entry {
  seq += 1
  return LogEntry.parse({
    seq,
    ts: new Date(Date.parse('2026-09-16T13:30:00Z') + seq * 1000).toISOString(),
    run_id: run,
    actor: 'analyst',
    prev_hash: HASH,
    hash: HASH,
    kind,
    payload,
  }) as Entry
}

const source = { name: 'Sentinel smoke model', retrieved_at: '2026-09-16T13:30:00Z', method: 'model' }

function fact(id: string, key: string, value: number | string, unit = 'percent', run = RUN) {
  return entry('fact', {
    fact: { id, run_id: run, key, label: 'x', value, unit, display: String(value), spoken: String(value), tolerance: {}, source, supersedes: null, created_at: '2026-09-16T13:30:00Z' },
  }, run)
}

const hours = Array.from({ length: 72 }, (_, h) => ({
  t: new Date(Date.UTC(2026, 8, 16, 4 + h)).toISOString(),
  source: h < 2 || h > 50 ? 'cams' : 'hrrr',
  smoke: h === 30 ? 40 : 0.5,
  past: h < 9,
}))

function output(extra: Record<string, unknown> = {}) {
  return entry('model.output', {
    model: 'ed_demand',
    version: 'smoke-nyc-log-all-literature',
    outputs: {
      label: 'Inova Alexandria',
      timezone: 'America/New_York',
      hrrr_cycle: '2026-09-16T06:00:00+00:00',
      hours,
      days: [
        { day: 1, date: '2026-09-16', smoke: { beyond_training: false }, heat: { extreme: true, level_name: 'major' }, fact_ids: { smoke_pct: 'F1', smoke_p10: 'F2', smoke_p90: 'F3', heat_p50: 'F5', heat_p90: 'F6' } },
        { day: 2, date: '2026-09-17', smoke: { beyond_training: true }, heat: { extreme: false, level_name: 'minor' }, fact_ids: {} },
      ],
      recommendations: [{ id: 1, cause: 'smoke', day: 2, text: 'from the log', fact_id: 'F7' }],
      storms: { flag: false, active: [] },
      fallbacks: ['HRRR missed 2 hours; CAMS fills them'],
      smoke_model: { literature: 'Gan RW et al. 2020', use_correction: false },
      heat_evidence: { cite: 'Sun S et al. BMJ 2021' },
      ...extra,
    },
  })
}

describe('next days view', () => {
  it('needs an ed_demand entry', () => {
    const s = foldAll([fact('F1', 'forecast.smoke.day1.pct', 1)])
    expect(nextDaysView(s, RUN)).toBeNull()
    expect(nextDaysView(s, null)).toBeNull()
  })

  it('links days to their facts', () => {
    const s = foldAll([
      fact('F1', 'forecast.smoke.day1.pct', 12.6),
      fact('F2', 'forecast.smoke.day1.p10', 6.3),
      fact('F3', 'forecast.smoke.day1.p90', 18.9),
      fact('F4', 'forecast.smoke.day2.pct', 30),
      fact('F5', 'forecast.heat.day1.pct', 7.8),
      fact('F6', 'forecast.heat.day1.p90', 8.1),
      fact('F7', 'forecast.recommendation.1', 'Add respiratory therapist hours on day two', 'text'),
      fact('F8', 'forecast.storm.warnings', 0, 'count'),
      output(),
    ])
    const v = nextDaysView(s, RUN)!
    expect(v.days[0]!.smoke.p50?.value).toBe(12.6)
    expect(v.days[0]!.heat.p90?.value).toBe(8.1)
    // day two has no ids in the entry, so it falls back to the key
    expect(v.days[1]!.smoke.p50?.value).toBe(30)
    expect(v.days[1]!.smoke.beyond).toBe(true)
    expect(v.recs[0]!.text).toBe('Add respiratory therapist hours on day two')
    expect(v.storm.warnings?.value).toBe(0)
    expect(v.correctionServed).toBe(false)
    expect(v.fallbacks).toHaveLength(1)
  })

  it('counts hours by source', () => {
    const v = nextDaysView(foldAll([output()]), RUN)!
    expect(v.hours).toHaveLength(72)
    expect(v.counts).toEqual({ hrrr: 49, cams: 23, none: 0 })
    expect(v.smokeTop).toBe(40)
    expect(v.barTop).toBe(10)
  })

  it('ignores other runs', () => {
    const s = foldAll([output(), fact('F1', 'forecast.smoke.day1.pct', 99, 'percent', 'run-other')])
    expect(nextDaysView(s, 'run-other')).toBeNull()
    expect(nextDaysView(s, RUN)!.days[0]!.smoke.p50).toBeUndefined()
  })

  it('survives a malformed entry', () => {
    const v = nextDaysView(foldAll([output({ days: 'nope', hours: [{ t: 5 }], recommendations: null })]), RUN)!
    expect(v.days).toEqual([])
    expect(v.hours[0]!.source).toBe('none')
    expect(v.recs).toEqual([])
  })
})

describe('bar helpers', () => {
  it('rounds scale tops up', () => {
    expect(niceTop(10)).toBe(10)
    expect(niceTop(12.6)).toBe(20)
    expect(niceTop(66.3)).toBe(100)
    expect(niceTop(0.4)).toBe(0.5)
  })

  it('clamps bar positions', () => {
    expect(barPos(-3, 10)).toBe(0)
    expect(barPos(5, 10)).toBe(0.5)
    expect(barPos(30, 10)).toBe(1)
  })

  it('keeps the local date', () => {
    expect(weekday('2026-09-16')).toBe('Wed, Sep 16')
    expect(weekday('garbage')).toBe('garbage')
  })
})
