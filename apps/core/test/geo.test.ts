import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../src/config.ts'
import { lognormalExceed, substationExceedance, voltageClass, hospitalExceedance } from '../src/geo/fragility.ts'
import { bandOf, exposureByBand } from '../src/geo/population.ts'
import {
  calibrationApplies,
  contourShaking,
  mmiRaw,
  mmiToPgaCm,
  pgaToMmi,
  radiusForMmi,
  shakingFor,
} from '../src/geo/shaking.ts'
import { zipsWithin } from '../src/geo/zips.ts'
import { DEFAULT_DRILL } from '../src/modes/drill-point.ts'

const drill = { lon: DEFAULT_DRILL.lon, lat: DEFAULT_DRILL.lat, mag: DEFAULT_DRILL.mag, depth_km: DEFAULT_DRILL.depth_km }

describe('intensity equation', () => {
  // the same numbers come out of the two open implementations we took the coefficients from
  it('matches reference implementation values', () => {
    expect(mmiRaw(5.8, Math.hypot(126, 6), 126, 'ena')).toBeCloseTo(4.52, 2)
    expect(mmiRaw(6.4, Math.hypot(10, 8), 10, 'ena')).toBeCloseTo(7.64, 2)
    expect(mmiRaw(6.4, Math.hypot(20, 8), 20, 'ena')).toBeCloseTo(7.09, 2)
    expect(mmiRaw(6.4, Math.hypot(50, 8), 50, 'ena')).toBeCloseTo(5.82, 2)
  })

  it('falls off with distance', () => {
    let last = Infinity
    for (const km of [5, 10, 25, 50, 100, 200, 400]) {
      const v = mmiRaw(6, Math.hypot(km, 10), km, 'ena')
      expect(v).toBeLessThan(last)
      last = v
    }
  })

  it('eastern term adds shaking', () => {
    expect(mmiRaw(6, 50, 50, 'ena')).toBeGreaterThan(mmiRaw(6, 50, 50, 'active'))
  })

  it('pga conversion round trips', () => {
    for (const m of [2.5, 4, 4.3, 6, 8.5]) expect(pgaToMmi(mmiToPgaCm(m))).toBeCloseTo(m, 6)
    expect(mmiToPgaCm(7) / 981).toBeCloseTo(0.215, 2)
  })
})

describe('regional calibration', () => {
  it('applies near Virginia only', () => {
    expect(calibrationApplies(drill)).toBe(true)
    expect(calibrationApplies({ lon: -118.2, lat: 34 })).toBe(false)
    expect(shakingFor({ ...drill, lon: 37, lat: 37.2 }).calibrated).toBe(false)
  })

  it('damaging radius is plausible', () => {
    const r = radiusForMmi(shakingFor(drill), drill, 7)
    expect(r).toBeGreaterThan(15)
    expect(r).toBeLessThan(40)
  })

  it('contours nest by level', () => {
    const c = contourShaking(shakingFor(drill), drill, { maxCells: 40_000 })
    const levels = c.features.map((f) => f.properties.mmi)
    expect(levels).toEqual([4, 5, 6, 7])
    expect(c.max_mmi).toBeGreaterThan(7.5)
  })
})

describe('exposure', () => {
  it('bands follow PAGER convention', () => {
    expect(bandOf(6.49)).toBe(6)
    expect(bandOf(6.5)).toBe(7)
    expect(bandOf(10.3)).toBe(10)
  })

  // Our footprint comes from an equation; PAGER's comes from ShakeMap, which is built from the
  // recorded shaking. Order-of-magnitude agreement is what we can honestly claim.
  it('2011 Virginia near PAGER', () => {
    const pager = JSON.parse(readFileSync(join(repoRoot, 'data/seeds/pager-se609212.json'), 'utf8')) as {
      event: { lon: number; lat: number; mag: number; depth_km: number }
      exposure: { dmax: number; pop: number }[]
    }
    const q = pager.event
    const theirs = (from: number) => pager.exposure.filter((b) => b.dmax - 0.5 >= from).reduce((t, b) => t + b.pop, 0)
    const ours = exposureByBand(shakingFor(q), q)
    const ratio5 = ours.at_least[5] / theirs(5)
    const ratio7 = ours.at_least[7] / theirs(7)
    expect(ratio5).toBeGreaterThan(1 / 3)
    expect(ratio5).toBeLessThan(3)
    expect(ratio7).toBeGreaterThan(1 / 3)
    expect(ratio7).toBeLessThan(3)
  })

  it('drill puts millions in damage', () => {
    const e = exposureByBand(shakingFor(drill), drill)
    expect(e.at_least[7]).toBeGreaterThan(1_000_000)
    expect(e.bands[9]).toBe(0)
  })
})

describe('zips', () => {
  it('finds Old Town nearby', () => {
    const z = zipsWithin(shakingFor(drill), drill, 10)
    const oldTown = z.find((p) => p.zcta === '22314')
    expect(oldTown).toBeDefined()
    expect(oldTown!.mmi).toBeGreaterThan(7)
    expect(z[0]!.dist_km).toBeLessThanOrEqual(z[z.length - 1]!.dist_km)
  })
})

describe('fragility', () => {
  it('median gives even odds', () => {
    expect(lognormalExceed(0.26, 0.26, 0.5)).toBeCloseTo(0.5, 6)
    expect(lognormalExceed(0, 0.26, 0.5)).toBe(0)
  })

  it('reads osm voltage tags', () => {
    expect(voltageClass('500000')).toBe('high')
    expect(voltageClass('230000;115000')).toBe('medium')
    expect(voltageClass('34500')).toBe('low')
    expect(voltageClass(undefined)).toBeNull()
  })

  it('damage states stay ordered', () => {
    const p = substationExceedance(0.3, 'high')
    expect(p.slight).toBeGreaterThanOrEqual(p.moderate)
    expect(p.moderate).toBeGreaterThanOrEqual(p.extensive)
    expect(p.extensive).toBeGreaterThanOrEqual(p.complete)
    expect(substationExceedance(0.13, 'high', false).moderate).toBeCloseTo(0.5, 6)
    const h = hospitalExceedance(0.26)
    expect(h.moderate).toBeCloseTo(0.5, 6)
  })
})
