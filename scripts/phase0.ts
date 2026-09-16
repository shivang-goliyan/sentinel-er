// Phase 0: can each outside service do what the plan needs? One table, no app code.
// Run: node --env-file-if-exists=.env scripts/phase0.ts
// Voice checks need a public wss:// endpoint; they live in scripts/voice-check.ts.
import { chat } from '../apps/core/src/llm/chain.ts'
import { USER_AGENT } from '../apps/core/src/tape.ts'

type Row = { check: string; ok: boolean | null; numbers: string; note: string }
const rows: Row[] = []

async function get(url: string, init: RequestInit = {}) {
  const t = Date.now()
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(30_000),
    headers: { 'user-agent': USER_AGENT, ...(init.headers as Record<string, string>) },
  })
  return { res, ms: Date.now() - t }
}

async function check(name: string, needs: string[], fn: () => Promise<Omit<Row, 'check'>>) {
  const missing = needs.filter((k) => !process.env[k])
  if (missing.length) {
    rows.push({ check: name, ok: null, numbers: '', note: `skipped, needs ${missing.join(', ')}` })
    return
  }
  try {
    rows.push({ check: name, ...(await fn()) })
  } catch (err) {
    rows.push({ check: name, ok: false, numbers: '', note: err instanceof Error ? err.message : String(err) })
  }
}

await check('emPOWER ZIP 22314', [], async () => {
  const url =
    'https://services2.arcgis.com/ZQ4jTQn6k7VPXEwO/arcgis/rest/services/HHS_emPOWER_REST_Service_Public/FeatureServer/1/query?where=Zip_Code%3D%2722314%27&outFields=*&returnGeometry=false&f=json'
  const { res, ms } = await get(url)
  const body = (await res.json()) as { features?: { attributes: Record<string, number> }[] }
  const a = body.features?.[0]?.attributes
  if (!a) return { ok: false, numbers: `${ms} ms`, note: 'no feature for 22314' }
  return {
    ok: true,
    numbers: `benes ${a.Medicare_Benes}, power-dependent ${a.Power_Dependent_Devices_DME}, O2 ${a.O2_Concentrators_36mo}; ${ms} ms`,
    note: '',
  }
})

await check('USGS PAGER exposure, Turkey 2023', [], async () => {
  const { res, ms } = await get('https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=us6000jllz&format=geojson')
  const ev = (await res.json()) as { properties: { products: Record<string, { contents: Record<string, { url: string }> }[]> } }
  const pager = ev.properties.products.losspager?.[0]
  const expUrl = pager?.contents['json/exposures.json']?.url
  if (!expUrl) return { ok: false, numbers: '', note: 'no exposures.json in losspager' }
  const exp = (await (await get(expUrl)).res.json()) as { population_exposure: { aggregated_exposure: number[] } }
  const agg = exp.population_exposure.aggregated_exposure
  return { ok: agg.length === 10, numbers: `MMI 7+ pop ${agg.slice(6).reduce((a, b) => a + b, 0).toLocaleString()}; ${ms} ms`, note: '' }
})

await check('HRRR near-surface smoke (byte range)', [], async () => {
  // latest 00/06/12/18z cycle that has published its f06 file
  const now = new Date()
  for (let back = 0; back < 36; back += 6) {
    const t = new Date(now.getTime() - back * 3_600_000)
    const cycle = Math.floor(t.getUTCHours() / 6) * 6
    const day = t.toISOString().slice(0, 10).replaceAll('-', '')
    const hh = String(cycle).padStart(2, '0')
    const base = `https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.${day}/conus/hrrr.t${hh}z.wrfsfcf06.grib2`
    const idx = await get(`${base}.idx`)
    if (!idx.res.ok) continue
    const lines = (await idx.res.text()).split('\n')
    const i = lines.findIndex((l) => l.includes(':MASSDEN:8 m above ground:'))
    if (i < 0) return { ok: false, numbers: '', note: `no MASSDEN line in ${day} ${hh}z idx` }
    const start = Number(lines[i]!.split(':')[1])
    const end = Number(lines[i + 1]?.split(':')[1] ?? start + 2_000_000) - 1
    const part = await get(base, { headers: { range: `bytes=${start}-${end}` } })
    const buf = Buffer.from(await part.res.arrayBuffer())
    const isGrib = buf.subarray(0, 4).toString('latin1') === 'GRIB'
    return { ok: isGrib, numbers: `${day} ${hh}z f06, ${buf.length.toLocaleString()} bytes`, note: isGrib ? '' : 'range did not start with GRIB' }
  }
  return { ok: false, numbers: '', note: 'no recent cycle found' }
})

await check('FEMA open shelters layer', [], async () => {
  const { res, ms } = await get(
    'https://gis.fema.gov/arcgis/rest/services/NSS/OpenShelters/FeatureServer/0/query?where=1%3D1&returnCountOnly=true&f=json',
  )
  const body = (await res.json()) as { count?: number; error?: { message: string }; messages?: string[] }
  if (typeof body.count !== 'number') {
    return { ok: false, numbers: `${ms} ms`, note: (body.error?.message ?? body.messages?.join(' ') ?? 'no count').trim() }
  }
  return { ok: true, numbers: `${body.count} open shelters; ${ms} ms`, note: 'cache it; the server is flaky' }
})

await check('CMS Hospital General Information', [], async () => {
  const { res, ms } = await get(
    'https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0?limit=1&conditions[0][property]=facility_name&conditions[0][value]=%25INOVA%20ALEXANDRIA%25&conditions[0][operator]=LIKE',
  )
  if (!res.ok) return { ok: false, numbers: `HTTP ${res.status}, ${ms} ms`, note: 'blocked from this network; fetch on the US server' }
  const body = (await res.json()) as { results?: Record<string, string>[] }
  const r = body.results?.[0]
  return { ok: Boolean(r), numbers: r ? `${r.facility_id} ${r.facility_name} ${r.telephone_number}` : '', note: '' }
})

await check('FEMA Hospitals RAPT (beds)', [], async () => {
  const { res, ms } = await get(
    "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Hospitals_RAPT/FeatureServer/6/query?where=NAME+LIKE+%27%25ALEXANDRIA%25%27+AND+STATE%3D%27VA%27&outFields=NAME,BEDS,TRAUMA,LATITUDE,LONGITUDE&returnGeometry=false&f=json",
  )
  const body = (await res.json()) as { features?: { attributes: Record<string, unknown> }[] }
  const a = body.features?.[0]?.attributes
  return { ok: Boolean(a), numbers: a ? `${a.NAME}: ${a.BEDS} beds, trauma ${a.TRAUMA}; ${ms} ms` : '', note: '' }
})

await check('NWS HeatRisk at Alexandria', [], async () => {
  const { res, ms } = await get(
    'https://mapservices.weather.noaa.gov/experimental/rest/services/NWS_HeatRisk/ImageServer/identify?geometry=%7B%22x%22%3A-77.0564%2C%22y%22%3A38.8069%2C%22spatialReference%22%3A%7B%22wkid%22%3A4326%7D%7D&geometryType=esriGeometryPoint&returnGeometry=false&f=json',
  )
  const body = (await res.json()) as { value?: string; properties?: { Values?: string[] } }
  return { ok: Boolean(body.properties?.Values?.length ?? body.value), numbers: `${JSON.stringify(body.properties?.Values ?? body.value)}; ${ms} ms`, note: '' }
})

await check('GDACS current events', [], async () => {
  const { res, ms } = await get('https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP')
  const body = (await res.json()) as { features?: unknown[] }
  return { ok: (body.features?.length ?? 0) > 0, numbers: `${body.features?.length} events; ${ms} ms`, note: '' }
})

await check('Census geocoder', [], async () => {
  const { res, ms } = await get(
    'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=4320+Seminary+Rd%2C+Alexandria%2C+VA+22304&benchmark=Public_AR_Current&format=json',
  )
  const body = (await res.json()) as { result: { addressMatches: { coordinates: { x: number; y: number } }[] } }
  const c = body.result.addressMatches[0]?.coordinates
  return { ok: Boolean(c), numbers: c ? `${c.y.toFixed(4)}, ${c.x.toFixed(4)}; ${ms} ms` : '', note: '' }
})

await check('Open-Meteo PM2.5 forecast', [], async () => {
  const { res, ms } = await get(
    'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=38.81&longitude=-77.05&hourly=pm2_5&forecast_days=5',
  )
  const body = (await res.json()) as { hourly: { pm2_5: (number | null)[] } }
  const filled = body.hourly.pm2_5.filter((v) => v !== null).length
  return { ok: filled > 48, numbers: `${filled} hourly values; ${ms} ms`, note: '' }
})

await check('OSRM demo drive time', [], async () => {
  const { res, ms } = await get(
    'https://router.project-osrm.org/route/v1/driving/-77.0470,38.8048;-77.1117,38.8893?overview=false',
  )
  const body = (await res.json()) as { routes?: { duration: number }[] }
  const d = body.routes?.[0]?.duration
  return { ok: Boolean(d), numbers: d ? `${Math.round(d / 60)} min; ${ms} ms` : '', note: '' }
})

await check('LLM voice chain (one short turn)', ['GEMINI_API_KEY'], async () => {
  const t = Date.now()
  const r = await chat({ lane: 'voice', messages: [{ role: 'user', content: 'Reply with the single word: ready' }], maxTokens: 20 })
  return { ok: /ready/i.test(r.text), numbers: `${r.provider}/${r.model}, ${Date.now() - t} ms`, note: r.text.slice(0, 40) }
})

await check('OpenRouteService avoid_polygons', ['ORS_API_KEY'], async () => {
  const body = (avoid: boolean) => ({
    coordinates: [
      [-77.047, 38.8048],
      [-77.1117, 38.8893],
    ],
    ...(avoid
      ? {
          options: {
            avoid_polygons: {
              type: 'Polygon',
              coordinates: [[[-77.09, 38.83], [-77.06, 38.83], [-77.06, 38.86], [-77.09, 38.86], [-77.09, 38.83]]],
            },
          },
        }
      : {}),
  })
  const run = async (avoid: boolean) => {
    const { res } = await get('https://api.openrouteservice.org/v2/directions/driving-car/geojson', {
      method: 'POST',
      headers: { authorization: process.env.ORS_API_KEY!, 'content-type': 'application/json' },
      body: JSON.stringify(body(avoid)),
    })
    const j = (await res.json()) as { features?: { properties: { summary: { distance: number } } }[]; error?: unknown }
    if (!res.ok) throw new Error(`ORS ${res.status}: ${JSON.stringify(j.error)}`)
    return j.features![0]!.properties.summary.distance
  }
  const plain = await run(false)
  const around = await run(true)
  return { ok: around > plain, numbers: `${(plain / 1000).toFixed(1)} km → ${(around / 1000).toFixed(1)} km`, note: '' }
})

await check('Google Places (IDs, then details)', ['GOOGLE_PLACES_API_KEY'], async () => {
  const key = process.env.GOOGLE_PLACES_API_KEY!
  const { res } = await get('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key, 'x-goog-fieldmask': 'places.id' },
    body: JSON.stringify({ textQuery: 'Inova Alexandria Hospital, 4320 Seminary Rd, Alexandria VA' }),
  })
  const ids = (await res.json()) as { places?: { id: string }[] }
  const id = ids.places?.[0]?.id
  if (!id) return { ok: false, numbers: '', note: `search returned ${res.status}` }
  const d = await get(`https://places.googleapis.com/v1/places/${id}`, {
    headers: {
      'x-goog-api-key': key,
      'x-goog-fieldmask': 'displayName,nationalPhoneNumber,websiteUri,currentOpeningHours,location',
    },
  })
  const p = (await d.res.json()) as { displayName?: { text: string }; nationalPhoneNumber?: string; websiteUri?: string }
  return { ok: Boolean(p.nationalPhoneNumber), numbers: `${p.displayName?.text}, ${p.nationalPhoneNumber}`, note: p.websiteUri ?? '' }
})

await check('Bright Data Web Unlocker', ['BRIGHTDATA_API_TOKEN', 'BRIGHTDATA_UNLOCKER_ZONE'], async () => {
  const { res, ms } = await get('https://api.brightdata.com/request', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.BRIGHTDATA_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ zone: process.env.BRIGHTDATA_UNLOCKER_ZONE, url: 'https://www.inova.org/locations/inova-alexandria-hospital', format: 'raw' }),
  })
  const text = await res.text()
  return { ok: res.ok && text.length > 1000, numbers: `HTTP ${res.status}, ${text.length.toLocaleString()} chars, ${ms} ms`, note: '' }
})

await check('NASA FIRMS key', ['FIRMS_MAP_KEY'], async () => {
  const { res, ms } = await get(`https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=${process.env.FIRMS_MAP_KEY}`)
  const body = (await res.json()) as Record<string, unknown>
  return { ok: res.ok, numbers: `${JSON.stringify(body)}; ${ms} ms`, note: '' }
})

const mark = (ok: boolean | null) => (ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL')
const width = Math.max(...rows.map((r) => r.check.length))
for (const r of rows) console.log(`${mark(r.ok).padEnd(5)} ${r.check.padEnd(width)}  ${r.numbers}${r.note ? `  — ${r.note}` : ''}`)
