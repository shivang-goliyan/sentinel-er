import { contours } from 'd3-contour'
import { haversineKm, readSeed, readSeedIfThere } from './seeds.ts'

interface IpeSeed {
  aww14: {
    c1: number
    c2: number
    c3: number
    c4: number
    c5: number
    c6: number
    h_km: number
    ena: { offset: number; slope_per_km: number; far_coef: number; far_ref_km: number; far_cap_km: number }
  }
  worden2012: { c1: number; c2: number; c3: number; c4: number; t1_log10_pga: number; t2_mmi: number }
}

export interface Calibration {
  event: string
  form: string
  a: number
  b: number
  r_min_km: number
  r_max_km: number
  bbox: [number, number, number, number]
  n_zips: number
  responses: number
  rmse_before: number
  rmse_after: number
}

const ipe = readSeed<IpeSeed>('ipe.json')
let calibration = readSeedIfThere<Calibration>('calibration-va2011.json')

export function setCalibration(c: Calibration | null) {
  calibration = c
}

export type Region = 'ena' | 'active'

export interface Quake {
  lon: number
  lat: number
  mag: number
  depth_km: number
}

// Central and eastern North America, where the ENA term applies. Everything else gets the
// base (California-derived) form and says so.
export function regionFor(lon: number, lat: number): Region {
  return lon > -105 && lon < -50 && lat > 24 && lat < 62 ? 'ena' : 'active'
}

export function mmiRaw(mag: number, rhypKm: number, repiKm: number, region: Region): number {
  const c = ipe.aww14
  const R = Math.sqrt(rhypKm * rhypKm + c.h_km * c.h_km)
  const logR = Math.log10(R)
  const B = Math.max(0, Math.log10(R / 50))
  let mmi = c.c1 + c.c2 * mag + c.c3 * logR + c.c4 * R + c.c5 * B + c.c6 * mag * logR
  if (region === 'ena') {
    const e = c.ena
    mmi += e.offset + e.slope_per_km * repiKm + Math.max(0, e.far_coef * Math.log10(Math.min(repiKm, e.far_cap_km) / e.far_ref_km))
  }
  return mmi
}

export function calibrationApplies(q: Pick<Quake, 'lon' | 'lat'>): boolean {
  if (!calibration) return false
  const [w, s, e, n] = calibration.bbox
  return q.lon >= w && q.lon <= e && q.lat >= s && q.lat <= n
}

export function correction(rhypKm: number): number {
  if (!calibration) return 0
  const r = Math.min(calibration.r_max_km, Math.max(calibration.r_min_km, rhypKm))
  return calibration.a + calibration.b * Math.log10(r)
}

export interface ShakingModel {
  region: Region
  calibrated: boolean
  calibration: Calibration | null
  at(lon: number, lat: number): { mmi: number; repi_km: number; rhyp_km: number }
}

const clampMmi = (m: number) => Math.min(10, Math.max(1, m))

export function shakingFor(q: Quake, opts: { calibrate?: boolean } = {}): ShakingModel {
  const region = regionFor(q.lon, q.lat)
  const calibrated = (opts.calibrate ?? true) && region === 'ena' && calibrationApplies(q)
  return {
    region,
    calibrated,
    calibration: calibrated ? calibration : null,
    at(lon, lat) {
      const repi = haversineKm(q.lon, q.lat, lon, lat)
      const rhyp = Math.sqrt(repi * repi + q.depth_km * q.depth_km)
      let mmi = mmiRaw(q.mag, rhyp, repi, region)
      if (calibrated) mmi += correction(rhyp)
      return { mmi: clampMmi(mmi), repi_km: repi, rhyp_km: rhyp }
    },
  }
}

// Worden et al. 2012, PGA in cm/s^2
export function mmiToPgaCm(mmi: number): number {
  const w = ipe.worden2012
  const logPga = mmi <= w.t2_mmi ? (mmi - w.c1) / w.c2 : (mmi - w.c3) / w.c4
  return 10 ** logPga
}

export function pgaToMmi(pgaCm: number): number {
  const w = ipe.worden2012
  const lp = Math.log10(pgaCm)
  return lp <= w.t1_log10_pga ? w.c1 + w.c2 * lp : w.c3 + w.c4 * lp
}

export const mmiToPgaG = (mmi: number) => mmiToPgaCm(mmi) / 981

// how far out shaking stays at or above a level, along the surface
export function radiusForMmi(model: ShakingModel, q: Quake, level: number, maxKm = 800): number {
  let lo = 0
  let hi = maxKm
  const at = (km: number) => model.at(q.lon + km / (111.32 * Math.cos((q.lat * Math.PI) / 180)), q.lat).mmi
  if (at(0) < level) return 0
  if (at(hi) >= level) return hi
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2
    if (at(mid) >= level) lo = mid
    else hi = mid
  }
  return lo
}

type Ring = [number, number][]
export interface ContourFeature {
  type: 'Feature'
  properties: { mmi: number }
  geometry: { type: 'MultiPolygon'; coordinates: Ring[][] }
}

const round = (v: number, dp: number) => Math.round(v * 10 ** dp) / 10 ** dp

// "shaking at or above N" areas, nested, as lon/lat MultiPolygons
export function contourShaking(
  model: ShakingModel,
  q: Quake,
  opts: { levels?: number[]; maxCells?: number } = {},
): { features: ContourFeature[]; step_deg: number; extent_km: number; max_mmi: number } {
  const levels = opts.levels ?? [4, 5, 6, 7, 8, 9, 10]
  const extentKm = Math.min(600, Math.max(20, radiusForMmi(model, q, levels[0]!) * 1.05))
  const cosLat = Math.cos((q.lat * Math.PI) / 180)
  const halfLat = extentKm / 110.57
  const halfLon = extentKm / (111.32 * cosLat)
  const maxCells = opts.maxCells ?? 500_000
  const step = Math.max(0.005, Math.sqrt((4 * halfLat * halfLon) / maxCells))
  const nx = Math.ceil((2 * halfLon) / step) + 1
  const ny = Math.ceil((2 * halfLat) / step) + 1
  const west = q.lon - halfLon
  const north = q.lat + halfLat
  const values = new Float64Array(nx * ny)
  let maxMmi = 0
  for (let j = 0; j < ny; j++) {
    const lat = north - j * step
    for (let i = 0; i < nx; i++) {
      const v = model.at(west + i * step, lat).mmi
      values[j * nx + i] = v
      if (v > maxMmi) maxMmi = v
    }
  }
  const polys = contours().size([nx, ny]).thresholds(levels)(Array.from(values))
  const features: ContourFeature[] = []
  for (const p of polys) {
    if (!p.coordinates.length) continue
    const coords = p.coordinates.map((poly) =>
      poly.map((ring) => ring.map((pt) => [round(west + (pt[0]! - 0.5) * step, 4), round(north - (pt[1]! - 0.5) * step, 4)] as [number, number])),
    )
    features.push({ type: 'Feature', properties: { mmi: p.value }, geometry: { type: 'MultiPolygon', coordinates: coords } })
  }
  return { features, step_deg: step, extent_km: extentKm, max_mmi: maxMmi }
}
