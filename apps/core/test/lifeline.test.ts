import { describe, expect, it } from 'vitest'
import { runLifelineStage } from '../src/crew/lifeline.ts'
import { distributionExceedance, nearestSubstations, outageAt, restoreText } from '../src/models/lifeline.ts'
import { makeDeps } from './helpers.ts'

const sub = (id: string, pgaG: number, lon = -77.1, lat = 38.8) => ({ id, lon, lat, pgaG, voltage: 'medium' as const })
const src = { name: 'HHS emPOWER', retrieved_at: 'now', method: 'api' as const }

describe('outage model', () => {
  it('stays dark-free without shaking', () => {
    const e = outageAt(0.001, [{ ...sub('a', 0.001), distKm: 1 }])
    expect(e.probability).toBeLessThan(0.01)
  })

  it('climbs with stronger shaking', () => {
    const weak = outageAt(0.1, [{ ...sub('a', 0.1), distKm: 1 }])
    const strong = outageAt(0.4, [{ ...sub('a', 0.4), distKm: 1 }])
    expect(strong.probability).toBeGreaterThan(weak.probability)
    expect(strong.probability).toBeGreaterThan(0.8)
  })

  it('uses the Hazus street medians', () => {
    // Table 8-30, unanchored: moderate median 0.33 g, so half exceed at the median
    expect(distributionExceedance(0.33).moderate).toBeCloseTo(0.5, 5)
  })

  it('picks the closest substations', () => {
    const near = nearestSubstations(-77.1, 38.8, [sub('far', 0.1, -76.5, 39.2), sub('near', 0.1, -77.1, 38.81)], 1)
    expect(near[0]!.id).toBe('near')
  })

  it('formats restoration times', () => {
    expect(restoreText(0.3)).toEqual({ display: '7 h', spoken: '7 hours' })
    expect(restoreText(6.8)).toEqual({ display: '7 days', spoken: '7 days' })
  })
})

describe('lifeline stage', () => {
  it('ranks ZIPs and writes facts', () => {
    const d = makeDeps()
    const rows = runLifelineStage(
      d,
      'r1',
      [
        { zcta: '22314', lon: -77.056, lat: 38.807, pgaG: 0.3, powerDependent: 136, oxygen: 63, ventilators: 2, masked: false },
        { zcta: '20001', lon: -77.02, lat: 38.91, pgaG: 0.08, powerDependent: 90, oxygen: 30, ventilators: 0, masked: false },
        { zcta: '22999', lon: -77.2, lat: 38.7, pgaG: 0.2, powerDependent: 11, oxygen: 11, ventilators: null, masked: true },
      ],
      [sub('s1', 0.3, -77.06, 38.81), sub('s2', 0.07, -77.02, 38.9)],
      src,
    )
    expect(rows[0]!.zcta).toBe('22314')
    const facts = d.facts.latest('r1')
    const masked = facts.find((f) => f.key === 'zip.22999.power_dependent')!
    expect(masked.display).toBe('≤11')
    expect(facts.every((f) => !/\d/.test(f.label))).toBe(true)
    expect(d.chain.after(0, 200).some((e) => e.kind === 'ledger' && e.payload.milestone === 'lifeline_ready')).toBe(true)
  })

  it('says so without counts', () => {
    const d = makeDeps()
    expect(runLifelineStage(d, 'r2', [], [], src)).toEqual([])
    expect(d.chain.after(0).at(-1)).toMatchObject({ payload: { state: 'blocked' } })
  })
})
