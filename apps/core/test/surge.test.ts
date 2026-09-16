import { describe, expect, it } from 'vitest'
import { runSurgeStage } from '../src/crew/surge.ts'
import { normName, occupancyFor } from '../src/models/occupancy.ts'
import {
  arrivalCurve,
  forecastSurge,
  functionalShare,
  hoursMinutes,
  minutesToFull,
  type SurgeHospital,
} from '../src/models/surge.ts'
import { makeDeps } from './helpers.ts'

const h = (id: string, beds: number, driveMin: number, pgaG = 0, occupancy = 0.7, lat = 38.8, lon = -77.1): SurgeHospital => ({
  id,
  name: `Hospital ${id}`,
  lat,
  lon,
  beds,
  occupancy,
  driveMin,
  pgaG,
})

describe('arrival curve', () => {
  it('matches the Chi-Chi record', () => {
    const a = arrivalCurve()
    // Chen et al. 2001: 53.2% within the first ten hours
    expect(a(10)).toBeGreaterThan(0.5)
    expect(a(10)).toBeLessThan(0.58)
  })

  it('only ever goes up', () => {
    const a = arrivalCurve()
    let last = 0
    for (let t = 0; t <= 72; t += 0.5) {
      expect(a(t)).toBeGreaterThanOrEqual(last)
      last = a(t)
    }
    expect(last).toBeGreaterThan(0.99)
  })
})

describe('damage and capacity', () => {
  it('keeps undamaged hospitals whole', () => {
    expect(functionalShare(0)).toBeCloseTo(1, 5)
  })

  it('loses beds as shaking grows', () => {
    expect(functionalShare(0.3)).toBeLessThan(functionalShare(0.1))
    expect(functionalShare(1.5)).toBeLessThan(0.2)
  })

  it('returns null when never full', () => {
    expect(minutesToFull(10, 0.5, 100, 0, arrivalCurve(), 72)).toBeNull()
  })
})

describe('forecastSurge', () => {
  const list = [h('near', 300, 5), h('far', 300, 40, 0, 0.7, 38.9, -77.0)]

  it('sends more people to nearer hospitals', () => {
    const rows = forecastSurge(list, { p10: 100, p50: 400, p90: 900 })
    const near = rows.find((r) => r.id === 'near')!
    expect(near.share).toBeGreaterThan(0.8)
  })

  it('fills sooner with more casualties', () => {
    const rows = forecastSurge(list, { p10: 200, p50: 600, p90: 1500 })
    const near = rows.find((r) => r.id === 'near')!
    expect(near.minutes.p10).not.toBeNull()
    expect(near.minutes.p10!).toBeLessThanOrEqual(near.minutes.p50!)
  })

  it('points overflow at a hospital with room', () => {
    const rows = forecastSurge(list, { p10: 200, p50: 600, p90: 1500 })
    expect(rows[0]!.id).toBe('near')
    expect(rows[0]!.divertTo).toBe('far')
  })

  it('counts reserved callers', () => {
    const plain = forecastSurge(list, { p10: 50, p50: 150, p90: 300 })
    const busy = forecastSurge(list, { p10: 50, p50: 150, p90: 300 }, { near: 120 })
    expect(busy.find((r) => r.id === 'near')!.arrivals.h3).toBeGreaterThan(plain.find((r) => r.id === 'near')!.arrivals.h3)
  })
})

describe('formatting and baselines', () => {
  it('rounds to five minutes', () => {
    expect(hoursMinutes(342)).toEqual({ display: '5 h 40 min', spoken: '5 hours 40 minutes' })
    expect(hoursMinutes(58)).toEqual({ display: '1 h', spoken: '1 hour' })
  })

  it('ignores hospital name noise', () => {
    expect(normName('Inova Alexandria Hospital')).toBe(normName('INOVA ALEXANDRIA HOSPITAL, INC.'))
  })

  it('finds a real facility baseline', () => {
    const occ = occupancyFor('Inova Alexandria Hospital', '22304', 'VA')
    expect(occ.how).toBe('facility')
    expect(occ.value).toBeGreaterThan(0.4)
    expect(occ.value).toBeLessThan(0.98)
  })
})

describe('surge stage', () => {
  it('writes facts and the ledger', async () => {
    const d = makeDeps()
    const run = 'r1'
    const src = { name: 'Sentinel casualty model', retrieved_at: 'now', method: 'model' as const }
    d.facts.add(run, { key: 'casualty.injured.p10', label: 'Injured, low estimate', value: 150, unit: 'people', source: src })
    d.facts.add(run, { key: 'casualty.injured.p50', label: 'Injured, middle estimate', value: 700, unit: 'people', source: src })
    d.facts.add(run, { key: 'casualty.injured.p90', label: 'Injured, high estimate', value: 2000, unit: 'people', source: src })
    const rows = await runSurgeStage(
      { ...d, drive: async (_f, to) => ({ minutes: to.map((_, i) => 5 + i * 15), source: 'osrm' }) },
      run,
      [
        { id: 'a', name: 'Inova Alexandria Hospital', lat: 38.83, lon: -77.11, zip: '22304', state: 'VA', beds: 312, pgaG: 0.3 },
        { id: 'b', name: 'Virginia Hospital Center', lat: 38.89, lon: -77.13, zip: '22205', state: 'VA', beds: 394, pgaG: 0.15 },
        { id: 'c', name: 'No Beds Clinic', lat: 38.8, lon: -77.1, zip: null, state: 'VA', beds: null, pgaG: 0.2 },
      ],
      { lon: -77.115, lat: 38.7925 },
    )
    expect(rows).toHaveLength(2)
    const keys = d.facts.latest(run).map((f) => f.key)
    expect(keys).toContain('surge.a.minutes_to_full')
    expect(keys).toContain('hospital.a.occupancy')
    const labels = d.facts.latest(run).map((f) => f.label)
    expect(labels.every((l) => !/\d/.test(l))).toBe(true)
    const log = d.chain.after(0, 500)
    expect(log.some((e) => e.kind === 'ledger' && e.payload.milestone === 'surge_forecast')).toBe(true)
  })

  it('waits for the casualty estimate', async () => {
    const d = makeDeps()
    const rows = await runSurgeStage(d, 'r2', [], { lon: 0, lat: 0 })
    expect(rows).toEqual([])
    expect(d.chain.after(0).at(-1)).toMatchObject({ kind: 'status', payload: { state: 'blocked' } })
  })
})
