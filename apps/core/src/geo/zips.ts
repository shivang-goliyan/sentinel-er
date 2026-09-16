import KDBush from 'kdbush'
import { around } from 'geokdbush'
import { readSeed } from './seeds.ts'
import { mmiToPgaG, type Quake, type ShakingModel } from './shaking.ts'

type Seed = { rows: [string, number, number][] }

let cache: { index: KDBush; rows: Seed['rows'] } | null = null

function zctaIndex() {
  if (cache) return cache
  const { rows } = readSeed<Seed>('zcta-2020.json')
  const index = new KDBush(rows.length)
  for (const [, lon, lat] of rows) index.add(lon, lat)
  index.finish()
  cache = { index, rows }
  return cache
}

export interface ZipPoint {
  zcta: string
  lon: number
  lat: number
  dist_km: number
  mmi: number
  pga_g: number
}

// ZCTA internal points within reach, nearest first, each with the shaking it would see
export function zipsWithin(model: ShakingModel, q: Quake, radiusKm: number, limit = Infinity): ZipPoint[] {
  const { index, rows } = zctaIndex()
  return around(index, q.lon, q.lat, limit, radiusKm).map((i) => {
    const [zcta, lon, lat] = rows[i]!
    const s = model.at(lon, lat)
    return { zcta, lon, lat, dist_km: s.repi_km, mmi: s.mmi, pga_g: mmiToPgaG(s.mmi) }
  })
}
