import { readSeedIfThere } from '../geo/seeds.ts'

interface Seed {
  source: string
  url: string
  window: { from: string; to: string }
  national: { source: string; url: string; then: number; now: number; now_week: string }
  retrieved_at: string
  rows: { ccn: string; name: string; city: string; zip: string; state: string; beds: number; occupancy: number; weeks: number }[]
}

export interface Occupancy {
  value: number
  hhsBeds: number | null
  ccn: string | null
  how: 'facility' | 'national'
  sourceName: string
  sourceUrl: string
}

const NOISE = /\b(THE|INC|LLC|HOSPITALS?|MEDICAL|CENTER|CENTRE|HEALTH|HEALTHCARE|SYSTEM|CAMPUS|OF|AND|AT|REGIONAL)\b/g
export const normName = (s: string) =>
  s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(NOISE, ' ').replace(/\s+/g, ' ').trim()

function overlap(a: string, b: string) {
  const x = new Set(a.split(' '))
  const y = new Set(b.split(' '))
  const common = [...x].filter((t) => y.has(t)).length
  return common / Math.max(x.size, y.size, 1)
}

let seed: Seed | null | undefined

export function occupancyFor(name: string, zip: string | null, state: string | null, file = 'occupancy-hhs-va-dc-md.json'): Occupancy {
  if (seed === undefined) seed = readSeedIfThere<Seed>(file) ?? readSeedIfThere<Seed>('occupancy-hhs-us.json')
  const s = seed
  if (!s) {
    return { value: 0.75, hhsBeds: null, ccn: null, how: 'national', sourceName: 'Leuchter et al., JAMA Netw Open 2025 (≈75%)', sourceUrl: '' }
  }
  const scale = s.national.now / s.national.then
  const n = normName(name)
  const z = (zip ?? '').slice(0, 5)
  const candidates = s.rows.filter((r) => (z && r.zip === z) || (!z && state && r.state === state))
  let best: Seed['rows'][number] | undefined
  let bestScore = 0
  for (const r of candidates) {
    const score = normName(r.name) === n ? 1 : overlap(normName(r.name), n)
    if (score > bestScore) {
      best = r
      bestScore = score
    }
  }
  if (best && bestScore >= 0.6) {
    return {
      value: Math.min(0.98, best.occupancy * scale),
      hhsBeds: best.beds,
      ccn: best.ccn,
      how: 'facility',
      sourceName: `HHS facility capacity ${s.window.from} to ${s.window.to}, scaled by CDC NHSN national occupancy (week of ${s.national.now_week})`,
      sourceUrl: s.url,
    }
  }
  return {
    value: s.national.now,
    hhsBeds: null,
    ccn: null,
    how: 'national',
    sourceName: `CDC NHSN national inpatient occupancy, week of ${s.national.now_week}`,
    sourceUrl: s.national.url,
  }
}
