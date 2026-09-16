// Will the power go out where people on home oxygen and ventilators live, and for how long?
// Earthquake path: Hazus substation damage (the grid) and distribution-circuit damage (the street).
import { lognormalExceed, substationExceedance, type DamageState, type Voltage } from '../geo/fragility.ts'
import { readSeed } from '../geo/seeds.ts'

const STATES: DamageState[] = ['slight', 'moderate', 'extensive', 'complete']

interface HazusSeed {
  substations: { restoration_days: { substation: [number, number][]; distribution_circuit: [number, number][] } }
  distribution_circuits: { curves: Record<'anchored' | 'unanchored', [number, number][]>; failed_share: number[] }
}
let hazus: HazusSeed | null = null
const seed = () => (hazus ??= readSeed<HazusSeed>('hazus.json'))

export interface Substation {
  id: string
  lon: number
  lat: number
  pgaG: number
  voltage: Voltage
  distKm: number
}

// P(exactly each state) from P(at least each state)
function exact(exceed: Record<DamageState, number>): Record<DamageState, number> {
  return {
    slight: exceed.slight - exceed.moderate,
    moderate: exceed.moderate - exceed.extensive,
    extensive: exceed.extensive - exceed.complete,
    complete: exceed.complete,
  }
}

export function distributionExceedance(pgaG: number, anchored = false): Record<DamageState, number> {
  const curves = seed().distribution_circuits.curves[anchored ? 'anchored' : 'unanchored']
  const out = {} as Record<DamageState, number>
  STATES.forEach((s, i) => (out[s] = lognormalExceed(pgaG, curves[i]![0], curves[i]![1])))
  return out
}

export interface OutageEstimate {
  probability: number // 0..1
  gridProbability: number
  streetProbability: number
  // expected days until power is back, given that it went out
  restoreDays: number | null
}

/**
 * Grid term: the area loses power if any of its nearby substations reaches moderate damage.
 * Street term: the chance this customer's own distribution circuit failed, which Hazus defines
 * through the share of failed circuits in each damage state. The two are treated as independent.
 */
export function outageAt(zipPgaG: number, substations: Substation[]): OutageEstimate {
  const { substation: subDays, distribution_circuit: distDays } = seed().substations.restoration_days
  const failedShare = seed().distribution_circuits.failed_share

  let noGrid = 1
  let gridDays = 0
  let gridWeight = 0
  for (const s of substations) {
    const e = substationExceedance(s.pgaG, s.voltage)
    noGrid *= 1 - e.moderate
    const x = exact(e)
    STATES.forEach((st, i) => {
      gridDays += x[st] * subDays[i]![0]
      gridWeight += x[st]
    })
  }
  const gridProbability = substations.length ? 1 - noGrid : 0

  const d = exact(distributionExceedance(zipPgaG))
  let streetProbability = 0
  let streetDays = 0
  let streetWeight = 0
  STATES.forEach((st, i) => {
    streetProbability += d[st] * failedShare[i]!
    streetDays += d[st] * distDays[i]![0]
    streetWeight += d[st]
  })

  const probability = 1 - (1 - gridProbability) * (1 - streetProbability)
  const days = [gridWeight > 0 ? gridDays / gridWeight : null, streetWeight > 0 ? streetDays / streetWeight : null].filter(
    (v): v is number => v !== null,
  )
  return { probability, gridProbability, streetProbability, restoreDays: days.length ? Math.max(...days) : null }
}

export function nearestSubstations(lon: number, lat: number, all: Omit<Substation, 'distKm'>[], k = 3): Substation[] {
  return all
    .map((s) => ({ ...s, distKm: Math.hypot((s.lat - lat) * 111, (s.lon - lon) * 111 * Math.cos((lat * Math.PI) / 180)) }))
    .sort((a, b) => a.distKm - b.distKm)
    .slice(0, k)
}

export function restoreText(days: number): { display: string; spoken: string } {
  if (days < 1) {
    const h = Math.max(1, Math.round(days * 24))
    return { display: `${h} h`, spoken: `${h} hour${h === 1 ? '' : 's'}` }
  }
  const d = Math.round(days * 2) / 2
  return { display: `${d} days`, spoken: `${d} days` }
}
