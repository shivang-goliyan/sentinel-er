import { readFileSync } from 'node:fs'
import KDBush from 'kdbush'
import { around } from 'geokdbush'
import { seedPath } from './seeds.ts'
import { radiusForMmi, type Quake, type ShakingModel } from './shaking.ts'

interface PointIndex {
  index: KDBush
  lon: Float32Array
  lat: Float32Array
  pop: Float32Array
}

let blockGroups: PointIndex | null = null

// Census 2020 block-group centres of population, US only
export function blockGroupIndex(): PointIndex {
  if (blockGroups) return blockGroups
  const buf = readFileSync(seedPath('blockgroups-2020.f32'))
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  const n = all.length / 3
  const lon = new Float32Array(n)
  const lat = new Float32Array(n)
  const pop = new Float32Array(n)
  const index = new KDBush(n)
  for (let i = 0; i < n; i++) {
    lon[i] = all[i * 3]!
    lat[i] = all[i * 3 + 1]!
    pop[i] = all[i * 3 + 2]!
    index.add(lon[i]!, lat[i]!)
  }
  index.finish()
  blockGroups = { index, lon, lat, pop }
  return blockGroups
}

export const BANDS = [4, 5, 6, 7, 8, 9, 10] as const
export type Band = (typeof BANDS)[number]

// PAGER's convention: band N holds MMI in [N-0.5, N+0.5), and 10 takes everything above
export function bandOf(mmi: number): number {
  return Math.min(10, Math.round(mmi))
}

export interface Exposure {
  bands: Record<Band, number>
  at_least: Record<Band, number>
  searched_km: number
  points: number
  source: string
}

export function exposureByBand(model: ShakingModel, q: Quake, opts: { maxKm?: number } = {}): Exposure {
  const idx = blockGroupIndex()
  const reach = Math.min(opts.maxKm ?? 800, radiusForMmi(model, q, 3.5) + 5)
  const ids = around(idx.index, q.lon, q.lat, Infinity, reach)
  const bands = Object.fromEntries(BANDS.map((b) => [b, 0])) as Record<Band, number>
  for (const i of ids) {
    const b = bandOf(model.at(idx.lon[i]!, idx.lat[i]!).mmi)
    if (b >= 4) bands[b as Band] += idx.pop[i]!
  }
  const at_least = { ...bands }
  for (let k = BANDS.length - 2; k >= 0; k--) at_least[BANDS[k]!] += at_least[BANDS[k + 1]!]
  return {
    bands,
    at_least,
    searched_km: reach,
    points: ids.length,
    source: 'US Census 2020 block-group centres of population',
  }
}
