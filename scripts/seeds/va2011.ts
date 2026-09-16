// Calibrates the intensity equation against the 23 Aug 2011 Mineral, Virginia M5.8 (se609212)
// using USGS "Did You Feel It?" ZIP averages, and saves USGS PAGER's exposure for the same event as
// a test fixture.
import { cached, getJson, writeSeed } from './lib.ts'
import { haversineKm } from '../../apps/core/src/geo/seeds.ts'
import { mmiRaw, regionFor, setCalibration, shakingFor, type Calibration } from '../../apps/core/src/geo/shaking.ts'
import { DEFAULT_DRILL } from '../../apps/core/src/modes/drill-point.ts'

const EVENT = 'se609212'
const MAX_RHYP_KM = 400
const MIN_RESPONSES = 3

type Detail = {
  properties: { mag: number; products: Record<string, { contents: Record<string, { url: string }> }[]> }
  geometry: { coordinates: [number, number, number] }
}
const detail = await getJson<Detail>(`https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=${EVENT}&format=geojson`)
const [lon, lat, depth] = detail.geometry.coordinates
const mag = detail.properties.mag

const dyfi = detail.properties.products.dyfi?.[0]
const cdiUrl = dyfi?.contents['cdi_zip.txt']?.url
if (!cdiUrl) throw new Error('no cdi_zip.txt in the preferred DYFI product')
const pagerUrl = detail.properties.products.losspager?.[0]?.contents['pager.xml']?.url
if (!pagerUrl) throw new Error('no pager.xml in losspager')

// --- DYFI ---
const rows: { rhyp: number; repi: number; cdi: number; n: number; lon: number; lat: number }[] = []
for (const line of (await cached(`${EVENT}-cdi_zip.txt`, cdiUrl)).toString('utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#')) continue
  const c = line.split(',')
  const cdi = Number(c[1])
  const n = Number(c[2])
  const zlat = Number(c[4])
  const zlon = Number(c[5])
  const suspect = Number(c[6])
  if (!Number.isFinite(cdi) || !Number.isFinite(zlat) || suspect || n < MIN_RESPONSES || cdi < 2) continue
  const repi = haversineKm(lon, lat, zlon, zlat)
  const rhyp = Math.hypot(repi, depth)
  if (rhyp > MAX_RHYP_KM) continue
  rows.push({ rhyp, repi, cdi, n, lon: zlon, lat: zlat })
}

// weighted least squares: residual = a + b*log10(rhyp)
let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0
const region = regionFor(lon, lat)
for (const r of rows) {
  const w = Math.sqrt(r.n)
  const x = Math.log10(r.rhyp)
  const y = r.cdi - mmiRaw(mag, r.rhyp, r.repi, region)
  sw += w; sx += w * x; sy += w * y; sxx += w * x * x; sxy += w * x * y
}
const b = (sw * sxy - sx * sy) / (sw * sxx - sx * sx)
const a = (sy - b * sx) / sw

const rmse = (f: (r: (typeof rows)[number]) => number) => {
  let s = 0, n = 0
  for (const r of rows) {
    const w = Math.sqrt(r.n)
    s += w * (r.cdi - f(r)) ** 2
    n += w
  }
  return Math.sqrt(s / n)
}
const rs = rows.map((r) => r.rhyp).sort((p, q) => p - q)
const lons = rows.map((r) => r.lon)
const lats = rows.map((r) => r.lat)
const cal: Calibration = {
  event: EVENT,
  form: 'MMI_calibrated = MMI_AWW14_ENA + a + b*log10(clamp(Rhyp, r_min_km, r_max_km)); applied only to epicentres inside bbox',
  a: Number(a.toFixed(4)),
  b: Number(b.toFixed(4)),
  r_min_km: Number(rs[0]!.toFixed(1)),
  r_max_km: Number(rs[rs.length - 1]!.toFixed(1)),
  bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)].map((v) => Number(v.toFixed(2))) as Calibration['bbox'],
  n_zips: rows.length,
  responses: rows.reduce((t, r) => t + r.n, 0),
  rmse_before: Number(rmse((r) => mmiRaw(mag, r.rhyp, r.repi, region)).toFixed(3)),
  rmse_after: 0,
}
const corr = (r: number) => cal.a + cal.b * Math.log10(Math.min(cal.r_max_km, Math.max(cal.r_min_km, r)))
cal.rmse_after = Number(rmse((r) => mmiRaw(mag, r.rhyp, r.repi, region) + corr(r.rhyp)).toFixed(3))
writeSeed('calibration-va2011.json', { ...cal, source: cdiUrl, fitted_at: new Date().toISOString(), min_responses: MIN_RESPONSES, max_rhyp_km: MAX_RHYP_KM })

// --- PAGER exposure fixture ---
const xml = (await cached(`${EVENT}-pager.xml`, pagerUrl)).toString('utf8')
const exposure: { dmin: number; dmax: number; pop: number }[] = []
for (const m of xml.matchAll(/<exposure\b([^>]*)\/?>/g)) {
  const attr = (k: string) => Number(new RegExp(`${k}="([^"]*)"`).exec(m[1]!)?.[1])
  exposure.push({ dmin: attr('dmin'), dmax: attr('dmax'), pop: attr('exposure') })
}
writeSeed('pager-se609212.json', { source: pagerUrl, event: { id: EVENT, lon, lat, depth_km: depth, mag }, exposure })

// --- what this means for the drill ---
setCalibration(cal)
const q = { lon: DEFAULT_DRILL.lon, lat: DEFAULT_DRILL.lat, mag: DEFAULT_DRILL.mag, depth_km: DEFAULT_DRILL.depth_km }
const raw = shakingFor(q, { calibrate: false })
const calibrated = shakingFor(q)
const east = (km: number) => q.lon + km / (111.32 * Math.cos((q.lat * Math.PI) / 180))
console.log(`fit on ${cal.n_zips} ZIPs (${cal.responses} responses): a=${cal.a} b=${cal.b}, rmse ${cal.rmse_before} → ${cal.rmse_after}`)
console.log(`calibration applies to the drill: ${calibrated.calibrated}`)
for (const km of [10, 20, 50]) {
  console.log(`M${q.mag} ${q.depth_km} km deep, ${km} km away: raw ${raw.at(east(km), q.lat).mmi.toFixed(2)}, calibrated ${calibrated.at(east(km), q.lat).mmi.toFixed(2)}`)
}
