import { readSeed } from './seeds.ts'

type Curve = [number, number]
interface HazusSeed {
  substations: { curves: Record<string, Curve[]> }
  hospitals: {
    fragility: { medians: number[]; beta: number }
    functionality_bands: Record<string, [number, number]>
  }
}

const hazus = readSeed<HazusSeed>('hazus.json')

// Abramowitz & Stegun 7.1.26, good to ~1e-7
function erf(x: number): number {
  const s = Math.sign(x)
  const t = 1 / (1 + 0.3275911 * Math.abs(x))
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return s * y
}

export const normCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2))

export function lognormalExceed(pgaG: number, median: number, beta: number): number {
  if (pgaG <= 0) return 0
  return normCdf(Math.log(pgaG / median) / beta)
}

export type Voltage = 'low' | 'medium' | 'high'
export type DamageState = 'slight' | 'moderate' | 'extensive' | 'complete'
const STATES: DamageState[] = ['slight', 'moderate', 'extensive', 'complete']

// OSM `voltage` is in volts and can list several circuits ("230000;115000"); the highest decides
export function voltageClass(tag: string | undefined): Voltage | null {
  if (!tag) return null
  const kv = Math.max(...tag.split(/[;,]/).map((v) => Number(v) / 1000).filter((v) => Number.isFinite(v) && v > 0))
  if (!Number.isFinite(kv)) return null
  if (kv >= 350) return 'high'
  if (kv >= 150) return 'medium'
  return 'low'
}

// P(damage >= each state), Hazus 6.1 table 8-29
export function substationExceedance(pgaG: number, voltage: Voltage, anchored = false): Record<DamageState, number> {
  const curves = hazus.substations.curves[`${voltage}_${anchored ? 'anchored' : 'unanchored'}`]
  if (!curves) throw new Error(`no substation curve for ${voltage}`)
  const out = {} as Record<DamageState, number>
  STATES.forEach((s, i) => {
    const [median, beta] = curves[i]!
    out[s] = lognormalExceed(pgaG, median, beta)
  })
  return out
}

// P(damage >= each state) for a hospital building. Hazus has no hospital-specific curve; C2M
// moderate-code (table 5-38) is our assumed building type, and the screen says so. Turning damage
// into bed capacity is the surge model's job.
export function hospitalExceedance(pgaG: number): Record<DamageState, number> {
  const { medians, beta } = hazus.hospitals.fragility
  const exceed = {} as Record<DamageState, number>
  STATES.forEach((s, i) => (exceed[s] = lognormalExceed(pgaG, medians[i]!, beta)))
  return exceed
}
