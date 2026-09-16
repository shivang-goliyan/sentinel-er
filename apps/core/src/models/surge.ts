// Where the injured go, how fast they arrive, and when each hospital runs out of room.
// Everything here is a plain function of its inputs so the numbers can be checked by hand.
import { hospitalExceedance } from '../geo/fragility.ts'

export interface SurgeHospital {
  id: string
  name: string
  lat: number
  lon: number
  beds: number
  occupancy: number // 0..1, today's best estimate
  driveMin: number // from the population-weighted centre of the damage
  pgaG: number // shaking at the hospital itself
}

export interface Injured {
  p10: number
  p50: number
  p90: number
}

export interface SurgeParams {
  // how much bigger hospitals attract more patients
  bedWeight: number
  // minutes; patients strongly prefer the closest door
  driveScaleMin: number
  // spare capacity a hospital can open quickly, as a share of its beds
  surgeFraction: number
  // share of patients who walk in within the first hour or so
  earlyShare: number
  earlyScaleH: number
  // gamma shape and median for everyone else
  lateShape: number
  lateMedianH: number
  horizonH: number
}

// Arrival timing follows the 1999 Chi-Chi earthquake record: about half of patients arrived
// within the first ten hours (Chen et al. 2001). The early walk-in share is our assumption.
export const DEFAULT_PARAMS: SurgeParams = {
  bedWeight: 1,
  driveScaleMin: 20,
  surgeFraction: 0.2,
  earlyShare: 0.08,
  earlyScaleH: 0.75,
  lateShape: 2,
  lateMedianH: 10,
  horizonH: 72,
}

// regularised lower incomplete gamma for integer shape: P(k, x) = 1 - e^-x Σ x^i/i!
function gammaCdfInt(k: number, x: number): number {
  if (x <= 0) return 0
  let term = 1
  let sum = 1
  for (let i = 1; i < k; i++) {
    term *= x / i
    sum += term
  }
  return 1 - Math.exp(-x) * sum
}

// median of a gamma with integer shape k, scale 1, found once by bisection
function gammaMedianUnit(k: number): number {
  let lo = 0
  let hi = 10 * k + 10
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (gammaCdfInt(k, mid) < 0.5) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

export function arrivalCurve(p: SurgeParams = DEFAULT_PARAMS) {
  const shape = Math.max(1, Math.round(p.lateShape))
  const scale = p.lateMedianH / gammaMedianUnit(shape)
  return (hours: number) =>
    p.earlyShare * (1 - Math.exp(-hours / p.earlyScaleH)) + (1 - p.earlyShare) * gammaCdfInt(shape, hours / scale)
}

// Share of the building still usable, from Hazus damage probabilities. The weights are ours:
// slight damage keeps most beds, moderate keeps a quarter, worse keeps none.
export function functionalShare(pgaG: number): number {
  const e = hospitalExceedance(pgaG)
  const none = 1 - e.slight
  const slight = e.slight - e.moderate
  const moderate = e.moderate - e.extensive
  return none + 0.75 * slight + 0.25 * moderate
}

export function surgeCapacity(h: SurgeHospital, p: SurgeParams = DEFAULT_PARAMS): number {
  const open = Math.max(0, h.beds * (1 - h.occupancy)) + p.surgeFraction * h.beds
  return open * functionalShare(h.pgaG)
}

export function shares(hospitals: SurgeHospital[], p: SurgeParams = DEFAULT_PARAMS): number[] {
  const w = hospitals.map((h) => h.beds ** p.bedWeight * Math.exp(-h.driveMin / p.driveScaleMin) * functionalShare(h.pgaG))
  const total = w.reduce((a, b) => a + b, 0)
  return total > 0 ? w.map((x) => x / total) : w.map(() => 0)
}

// minutes until arrivals reach capacity, or null if not within the horizon
export function minutesToFull(total: number, share: number, capacity: number, reserved: number, curve: (h: number) => number, horizonH: number) {
  const arrived = (h: number) => total * share * curve(h) + reserved
  if (arrived(horizonH) < capacity) return null
  if (arrived(0) >= capacity) return 0
  let lo = 0
  let hi = horizonH
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (arrived(mid) >= capacity) hi = mid
    else lo = mid
  }
  return Math.round(hi * 60)
}

export interface SurgeRow {
  id: string
  name: string
  share: number
  capacity: number
  functional: number
  arrivals: { h1: number; h3: number; h6: number; h24: number }
  minutes: { p10: number | null; p50: number | null; p90: number | null }
  divertTo: string | null
}

export function forecastSurge(
  hospitals: SurgeHospital[],
  injured: Injured,
  reserved: Record<string, number> = {},
  p: SurgeParams = DEFAULT_PARAMS,
): SurgeRow[] {
  const curve = arrivalCurve(p)
  const s = shares(hospitals, p)
  const rows = hospitals.map((h, i) => {
    const share = s[i]!
    const capacity = surgeCapacity(h, p)
    const r = reserved[h.id] ?? 0
    const at = (hours: number) => Math.round(injured.p50 * share * curve(hours) + r)
    return {
      id: h.id,
      name: h.name,
      share,
      capacity: Math.round(capacity),
      functional: functionalShare(h.pgaG),
      arrivals: { h1: at(1), h3: at(3), h6: at(6), h24: at(24) },
      // more injured means filling sooner, so the p90 casualty figure gives the earliest time
      minutes: {
        p10: minutesToFull(injured.p90, share, capacity, r, curve, p.horizonH),
        p50: minutesToFull(injured.p50, share, capacity, r, curve, p.horizonH),
        p90: minutesToFull(injured.p10, share, capacity, r, curve, p.horizonH),
      },
      divertTo: null as string | null,
    }
  })

  // send overflow to the nearby hospital with the most room left after six hours
  for (const row of rows) {
    if (row.minutes.p50 === null) continue
    const me = hospitals.find((h) => h.id === row.id)!
    let best: { id: string; score: number } | null = null
    for (const other of rows) {
      if (other.id === row.id || other.minutes.p50 !== null) continue
      const o = hospitals.find((h) => h.id === other.id)!
      const room = other.capacity - other.arrivals.h6
      if (room <= 0) continue
      const km = Math.hypot((o.lat - me.lat) * 111, (o.lon - me.lon) * 111 * Math.cos((me.lat * Math.PI) / 180))
      const score = room / (1 + km / 10)
      if (!best || score > best.score) best = { id: other.id, score }
    }
    row.divertTo = best?.id ?? null
  }

  return rows.sort((a, b) => (a.minutes.p50 ?? Infinity) - (b.minutes.p50 ?? Infinity) || b.share - a.share)
}

export function hoursMinutes(min: number): { display: string; spoken: string } {
  const h = Math.floor(min / 60)
  const m = Math.round((min - h * 60) / 5) * 5
  const hh = m === 60 ? h + 1 : h
  const mm = m === 60 ? 0 : m
  if (hh === 0) return { display: `${mm} min`, spoken: `${mm} minutes` }
  return {
    display: mm ? `${hh} h ${mm} min` : `${hh} h`,
    spoken: `${hh} hour${hh === 1 ? '' : 's'}${mm ? ` ${mm} minutes` : ''}`,
  }
}
