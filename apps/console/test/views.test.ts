import { describe, expect, it } from 'vitest'
import { LogEntry, type Fact, type LogEntry as Entry } from '@sentinel/shared'
import { foldAll } from '../src/store/fold'
import {
  bandValues,
  casualtyView,
  featureName,
  lifelineView,
  lineWith,
  runArtifacts,
  sitrepChecks,
  surgeRows,
} from '../src/store/views'
import { decadeTop, decades, logPos, shortCount } from '../src/lib/scale'

const HASH = 'b'.repeat(64)
const RUN = 'run-7'
let seq = 0

function entry(kind: string, payload: unknown, run: string | null = RUN, actor = 'analyst'): Entry {
  seq += 1
  return LogEntry.parse({
    seq,
    ts: new Date(Date.parse('2026-09-19T13:30:00Z') + seq * 1000).toISOString(),
    run_id: run,
    actor,
    prev_hash: HASH,
    hash: HASH,
    kind,
    payload,
  }) as Entry
}

const source = { name: 'Sentinel casualty model', retrieved_at: '2026-09-19T13:30:00Z', method: 'model' }

function fact(id: string, key: string, value: number | string, extra: Partial<Fact> = {}) {
  return entry('fact', {
    fact: {
      id,
      run_id: RUN,
      key,
      label: key,
      value,
      unit: typeof value === 'number' ? 'people' : 'text',
      display: typeof value === 'number' ? value.toLocaleString('en-US') : value,
      spoken: String(value),
      source,
      created_at: '2026-09-19T13:30:05Z',
      ...extra,
    },
  })
}

const start = () =>
  entry('run.started', { event_id: 'drill-1', mode: 'drill', title: 'DRILL · M6.4', detected_at: '2026-09-19T13:30:00Z' }, RUN, 'orchestrator')

function casualties() {
  return [
    fact('F1', 'casualty.deaths.p10', 2),
    fact('F2', 'casualty.deaths.p50', 23),
    fact('F3', 'casualty.deaths.p90', 101),
    fact('F4', 'casualty.deaths.planning', 101),
    fact('F5', 'casualty.injured.p10', 75),
    fact('F6', 'casualty.injured.p50', 819),
    fact('F7', 'casualty.injured.p90', 1813),
    entry('model.output', {
      model: 'casualty',
      version: 'without_pager_alert',
      outputs: {
        deaths: { p10: 2, p50: 23, p90: 101 },
        prior_deaths: 43,
        planning: 'p90',
        model: { variant: 'without_pager_alert' },
        explain: {
          contributions: [
            { feature: 'log_pop_mmi8', contribution_log1p: 0.1, value: 13.9 },
            { feature: 'log_global_expected', contribution_log1p: -0.91, value: 7.9 },
            { feature: 'country_factor', contribution_log1p: 0.53, value: -1.8 },
            { feature: 'magnitude', contribution_log1p: 0.02, value: 6.4 },
            { feature: 'broken' },
          ],
        },
      },
    }),
  ]
}

describe('casualty view', () => {
  it('returns null before estimates', () => {
    seq = 0
    expect(casualtyView(foldAll([start()]), RUN)).toBeNull()
    expect(casualtyView(foldAll([start()]), null)).toBeNull()
  })

  it('picks band facts by key', () => {
    seq = 0
    const v = casualtyView(foldAll([start(), ...casualties()]), RUN)!
    expect(v.deaths.planning?.id).toBe('F4')
    expect(v.injured.planning).toBeUndefined()
    expect(bandValues(v.injured)).toEqual({ p10: 75, p50: 819, p90: 1813 })
    expect(v.priorDeaths).toBe(43)
  })

  it('ranks drivers by size', () => {
    seq = 0
    const v = casualtyView(foldAll([start(), ...casualties()]), RUN)!
    expect(v.contributions.map((c) => c.feature)).toEqual(['log_global_expected', 'country_factor', 'log_pop_mmi8'])
    expect(v.contributions[2]!.name).toBe('People in shaking level VIII')
  })

  it('uses the newest fact value', () => {
    seq = 0
    const s = foldAll([start(), ...casualties(), fact('F9', 'casualty.deaths.p50', 30, { supersedes: 'F2' })])
    expect(casualtyView(s, RUN)!.deaths.p50?.id).toBe('F9')
  })

  it('names features for people', () => {
    expect(featureName('country_factor')).toBe("Country's past quake record")
    expect(featureName('log_pop_mmi10')).toBe('People in shaking level X')
    expect(featureName('log_new_thing')).toBe('new thing')
  })
})

describe('surge rows', () => {
  function surge(firstFills: boolean) {
    return [
      fact('Fa', 'surge.h1.minutes_to_full', firstFills ? 562 : 'not within three days'),
      fact('Fb', 'surge.h2.minutes_to_full', 685),
      fact('Fc', 'surge.h3.minutes_to_full', 700),
      entry('model.output', {
        model: 'surge',
        version: 'surge-1',
        outputs: {
          rows: [
            { id: 'h1', name: 'Inova Fairfax Hospital', fact_ids: { minutes_to_full: 'Fa', share: 'Fs', junk: 4 } },
            { id: 'h2', name: 'Inova Alexandria Hospital', fact_ids: { minutes_to_full: 'Fb' } },
            { id: 'h3', name: 'Fort Belvoir', fact_ids: { minutes_to_full: 'Fc' } },
            { name: 'no id' },
          ],
        },
      }),
    ]
  }

  it('flags the first filler', () => {
    seq = 0
    const rows = surgeRows(foldAll([start(), ...surge(true)]), RUN)
    expect(rows.map((r) => r.fillsFirst)).toEqual([true, false, false])
    expect(rows[0]!.ids).toEqual({ minutes_to_full: 'Fa', share: 'Fs' })
  })

  it('skips rows that never fill', () => {
    seq = 0
    const rows = surgeRows(foldAll([start(), ...surge(false)]), RUN)
    expect(rows.map((r) => r.fillsFirst)).toEqual([false, true, false])
    expect(rows[0]!.fills).toBe(false)
  })

  it('ignores other runs output', () => {
    seq = 0
    const s = foldAll([start(), ...surge(true)])
    expect(surgeRows(s, 'run-other')).toEqual([])
  })
})

describe('lifeline view', () => {
  it('reads rows and totals', () => {
    seq = 0
    const s = foldAll([
      start(),
      fact('Fz', 'zip.22314.outage_probability', 0.96, { unit: 'probability', display: '96%' }),
      fact('Fy', 'zip.22314.power_dependent', 11, { display: '≤11' }),
      fact('Ft', 'lifeline.total_at_risk', 19855),
      fact('Fu', 'lifeline.zip_count', 268),
      entry('model.output', {
        model: 'lifeline',
        version: 'lifeline-eq-1',
        outputs: {
          rows: [
            { zcta: '22314', fact_ids: { outage_probability: 'Fz', power_dependent: 'Fy' } },
            { zcta: '22301', fact_ids: {} },
          ],
        },
      }),
    ])
    const v = lifelineView(s, RUN)!
    expect(v.totalId).toBe('Ft')
    expect(v.zipCountId).toBe('Fu')
    expect(v.rows.map((r) => r.outage)).toEqual([0.96, null])
  })

  it('stays empty without output', () => {
    seq = 0
    expect(lifelineView(foldAll([start()]), RUN)).toBeNull()
  })
})

describe('sitrep checks', () => {
  const beds = { name: 'FEMA Hospitals (RAPT copy of HIFLD)', retrieved_at: '2026-09-19T13:00:00Z', method: 'dataset' as const }
  const draft = 'DRILL — report\n## Hospital surge\n- Beds, Inova Alexandria Hospital: 430\n- Fills first: {Fb}'

  it('ties the fault to its block', () => {
    seq = 0
    const s = foldAll([
      start(),
      fact('Fe', 'hospital.x.beds', 312, { label: 'Beds, Inova Alexandria Hospital', unit: 'beds', source: beds }),
      entry('fault.injected', { fault: 'bed_count', detail: 'Beds, Inova Alexandria Hospital replaced with 430' }, RUN, 'system'),
      entry('sitrep.draft', { attempt: 1, text: draft }),
      entry(
        'verify.block',
        {
          channel: 'sitrep',
          target: 'sitrep draft 1',
          text: draft,
          findings: [
            { kind: 'bare_number', text: '430', fact_id: 'Fe', expected: '312', source: beds },
            { kind: 'unknown_fact', text: '{F99}' },
          ],
        },
        RUN,
        'verifier',
      ),
      entry('verify.pass', { channel: 'sitrep', target: 'sitrep draft 2', findings: [{ kind: 'bare_number', text: 'three' }] }, RUN, 'verifier'),
      entry('verify.pass', { channel: 'voice', target: 'call line' }, RUN, 'verifier'),
    ])
    const checks = sitrepChecks(s, RUN)
    expect(checks.map((c) => [c.attempt, c.verdict])).toEqual([
      [1, 'block'],
      [2, 'pass'],
    ])
    const [blocked, passed] = checks
    expect(blocked!.injected).toContain('replaced with 430')
    expect(blocked!.findings[0]).toMatchObject({
      wrote: '430',
      expected: '312',
      about: 'Beds, Inova Alexandria Hospital',
      sourceName: 'FEMA Hospitals (RAPT copy of HIFLD)',
      line: 'Beds, Inova Alexandria Hospital: 430',
      injected: true,
    })
    expect(blocked!.findings[1]!.injected).toBe(false)
    expect(passed!.findings).toEqual([])
  })

  it('marks the template pass', () => {
    seq = 0
    const s = foldAll([start(), entry('verify.pass', { channel: 'sitrep', target: 'template sitrep' }, RUN, 'verifier')])
    const [c] = sitrepChecks(s, RUN)
    expect(c).toMatchObject({ template: true, attempt: null, injected: null })
  })

  it('finds whole numbers only', () => {
    const text = 'Beds: 1,430 total\nBeds at Inova: 430.\nphone 504-3000'
    expect(lineWith(text, '430')).toBe('Beds at Inova: 430.')
    expect(lineWith(text, '99')).toBeUndefined()
    expect(lineWith(`- ${'x'.repeat(200)} 430 ${'y'.repeat(200)}`, '430', 40)).toMatch(/^….*430.*…$/)
  })
})

describe('run artifacts', () => {
  it('keeps latest per file', () => {
    seq = 0
    const s = foldAll([
      start(),
      entry('artifact', { type: 'drone_plan', name: 'drone.plan', url: '/a/1' }),
      entry('artifact', { type: 'sitrep_pdf', name: 'sitrep.pdf', url: '/a/2' }),
      entry('artifact', { type: 'drone_plan', name: 'drone.plan', url: '/a/3' }),
      entry('artifact', { type: 'sitrep_pdf', name: 'sitrep.pdf', url: '/b/1' }, 'run-other'),
    ])
    expect(runArtifacts(s.artifacts, RUN).map((a) => a.url)).toEqual(['/a/3', '/a/2'])
    expect(runArtifacts(s.artifacts, null)).toEqual([])
  })
})

describe('log scale', () => {
  it('rounds up to decades', () => {
    expect(decadeTop(1813)).toBe(10000)
    expect(decadeTop(1000)).toBe(1000)
    expect(decadeTop(3)).toBe(10)
    expect(decades(1000)).toEqual([0, 1, 10, 100, 1000])
  })

  it('places values on axis', () => {
    expect(logPos(0, 100)).toBe(0)
    expect(logPos(100, 100)).toBeCloseTo(1)
    expect(logPos(5000, 100)).toBe(1)
    expect(shortCount(10000)).toBe('10k')
  })
})
