// One function per public feed, each returning normalised events. Shapes checked live on 16 Sept 2026.
import type { HazardEvent, HazardType } from '@sentinel/shared'
import { tapedFetch } from '../tape.ts'

const now = () => new Date().toISOString()

function base(e: Omit<HazardEvent, 'detected_at' | 'ingested_at' | 'tier' | 'status' | 'is_drill'> & { detected_at?: string }): HazardEvent {
  const t = now()
  return { detected_at: t, ingested_at: t, tier: 0, status: 'watch', is_drill: false, ...e }
}

// ---- USGS ----

interface UsgsFeature {
  id: string
  properties: {
    mag: number | null
    place: string | null
    time: number
    updated: number
    url: string
    detail: string
    felt: number | null
    mmi: number | null
    alert: 'green' | 'yellow' | 'orange' | 'red' | null
    title: string
    status: string
  }
  geometry: { type: 'Point'; coordinates: [number, number, number] }
}

export interface UsgsQuake {
  event: HazardEvent
  updated: number
  detailUrl: string
  felt: number
}

export async function usgsRecent(minMag: number, feed = 'all_hour'): Promise<UsgsQuake[]> {
  const res = await tapedFetch('usgs', `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${feed}.geojson`)
  const body = res.json<{ features: UsgsFeature[] }>()
  return body.features
    .filter((f) => (f.properties.mag ?? 0) >= minMag)
    .map((f) => {
      const [lon, lat, depth] = f.geometry.coordinates
      const p = f.properties
      return {
        updated: p.updated,
        detailUrl: p.detail,
        felt: p.felt ?? 0,
        event: base({
          id: `usgs:${f.id}`,
          type: 'earthquake',
          title: p.title,
          geometry: { type: 'Point', coordinates: [lon, lat] },
          severity: {
            mag: p.mag,
            depth_km: depth,
            pager_alert: p.alert,
            mmi_max: p.mmi,
            origin_time: new Date(p.time).toISOString(),
            place: p.place,
            felt: p.felt ?? 0,
          },
          sources: [{ name: 'USGS', id: f.id, url: p.url, published_at: new Date(p.time).toISOString() }],
        }),
      }
    })
}

export interface PagerExposure {
  // people per integer MMI band, index 0 = MMI I
  byMmi: number[]
  alert: string | null
}

export async function usgsPagerExposure(detailUrl: string): Promise<PagerExposure | null> {
  const detail = (await tapedFetch('usgs', detailUrl)).json<{
    properties: { products?: Record<string, { properties?: Record<string, string>; contents: Record<string, { url: string }> }[]> }
  }>()
  const pager = detail.properties.products?.losspager?.[0]
  const url = pager?.contents['json/exposures.json']?.url
  if (!url) return null
  const exp = (await tapedFetch('usgs', url)).json<{ population_exposure: { aggregated_exposure: number[] } }>()
  return { byMmi: exp.population_exposure.aggregated_exposure, alert: pager?.properties?.alertlevel ?? null }
}

// ---- GDACS ----

const GDACS_TYPES: Record<string, HazardType> = {
  EQ: 'earthquake',
  TC: 'cyclone',
  FL: 'flood',
  VO: 'volcano',
  DR: 'drought',
  WF: 'wildfire',
}

interface GdacsFeature {
  properties: {
    eventtype: string
    eventid: number
    episodeid: number
    name: string
    alertlevel: 'Green' | 'Orange' | 'Red'
    country: string
    fromdate: string
    severitydata?: { severity: number; severitytext: string; severityunit: string }
    url?: { report?: string }
  }
  geometry: { type: 'Point'; coordinates: [number, number] }
}

export interface GdacsItem {
  event: HazardEvent
  alert: 'Green' | 'Orange' | 'Red'
  magnitude: number | null
  at: number
}

export async function gdacsCurrent(): Promise<GdacsItem[]> {
  const res = await tapedFetch('gdacs', 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP')
  const body = res.json<{ features: GdacsFeature[] }>()
  return body.features
    .filter((f) => GDACS_TYPES[f.properties.eventtype])
    .map((f) => {
      const p = f.properties
      const at = Date.parse(`${p.fromdate}Z`)
      return {
        alert: p.alertlevel,
        magnitude: p.eventtype === 'EQ' ? (p.severitydata?.severity ?? null) : null,
        at,
        event: base({
          id: `gdacs:${p.eventtype}:${p.eventid}`,
          type: GDACS_TYPES[p.eventtype]!,
          title: p.name,
          geometry: f.geometry,
          severity: { alert: p.alertlevel, text: p.severitydata?.severitytext ?? null, country: p.country },
          sources: [{ name: 'GDACS', id: String(p.eventid), url: p.url?.report, published_at: new Date(at).toISOString() }],
        }),
      }
    })
}

// ---- NASA EONET ----

interface EonetEvent {
  id: string
  title: string
  link: string
  categories: { id: string }[]
  geometry: { date: string; type: string; coordinates: unknown; magnitudeValue?: number | null; magnitudeUnit?: string | null }[]
}

const EONET_TYPES: Record<string, HazardType> = { wildfires: 'wildfire', severeStorms: 'cyclone', volcanoes: 'volcano', floods: 'flood' }

export async function eonetOpen(days = 2): Promise<HazardEvent[]> {
  const res = await tapedFetch(
    'eonet',
    `https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=${days}&category=wildfires,severeStorms,volcanoes,floods`,
  )
  return res.json<{ events: EonetEvent[] }>().events.map((e) => {
    const last = e.geometry.at(-1)
    return base({
      id: `eonet:${e.id}`,
      type: EONET_TYPES[e.categories[0]?.id ?? ''] ?? 'natural',
      title: e.title,
      geometry: { type: last?.type === 'Polygon' ? 'Polygon' : 'Point', coordinates: last?.coordinates ?? [0, 0] },
      severity: { magnitude: last?.magnitudeValue ?? null, unit: last?.magnitudeUnit ?? null },
      sources: [{ name: 'NASA EONET', id: e.id, url: e.link, published_at: last?.date }],
    })
  })
}

// ---- NOAA SWPC ----

export async function swpcStorms(): Promise<HazardEvent[]> {
  const res = await tapedFetch('swpc', 'https://services.swpc.noaa.gov/products/alerts.json')
  const items = res.json<{ product_id: string; issue_datetime: string; message: string }[]>()
  const out: HazardEvent[] = []
  for (const a of items) {
    // alerts and warnings name the NOAA scale; G3 and above can reach power grids at mid latitudes
    const g = a.message.match(/Geomagnetic Storm Category G([1-5])/)?.[1]
    const k = a.message.match(/K-index of ([0-9])/)?.[1]
    const level = g ? Number(g) : k ? Math.max(0, Number(k) - 4) : 0
    if (level < 3) continue
    const at = new Date(`${a.issue_datetime.replace(' ', 'T')}Z`).toISOString()
    out.push(
      base({
        id: `swpc:${a.product_id}:${a.issue_datetime}`,
        type: 'space_weather',
        title: `Geomagnetic storm, NOAA scale G${level}`,
        geometry: { type: 'Point', coordinates: [0, 90] },
        severity: { g_scale: level },
        sources: [{ name: 'NOAA SWPC', id: a.product_id, url: 'https://www.swpc.noaa.gov/products/alerts-watches-and-warnings', published_at: at }],
      }),
    )
  }
  return out
}

// ---- NWS ----

interface NwsFeature {
  id: string
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown } | null
  properties: { event: string; severity: string; urgency: string; headline: string | null; areaDesc: string; sent: string; status: string }
}

const NWS_TYPES: [RegExp, HazardType][] = [
  [/flood/i, 'flood'],
  [/hurricane|tropical|typhoon/i, 'cyclone'],
  [/fire/i, 'wildfire'],
]

export async function nwsSevere(): Promise<HazardEvent[]> {
  const res = await tapedFetch('nws', 'https://api.weather.gov/alerts/active?severity=Extreme,Severe&urgency=Immediate', {
    headers: { accept: 'application/geo+json' },
  })
  return res
    .json<{ features: NwsFeature[] }>()
    .features.filter((f) => f.properties.status === 'Actual' && f.geometry)
    .map((f) =>
      base({
        id: `nws:${f.id.split(':').at(-1)}`,
        type: NWS_TYPES.find(([re]) => re.test(f.properties.event))?.[1] ?? 'natural',
        title: `${f.properties.event}: ${f.properties.areaDesc}`.slice(0, 160),
        geometry: f.geometry!,
        severity: { severity: f.properties.severity, urgency: f.properties.urgency, headline: f.properties.headline },
        sources: [{ name: 'NWS', id: f.id, url: f.id, published_at: f.properties.sent }],
      }),
    )
}

// ---- NASA FIRMS ----

export interface FireCluster {
  event: HazardEvent
  count: number
}

// Detections within ~2 km chain into one fire; a cluster needs at least three.
export function clusterFires(points: { lat: number; lon: number; frp: number; at: string }[], epsKm = 2, minPts = 3) {
  const seen = new Array(points.length).fill(false)
  const near = (a: (typeof points)[number], b: (typeof points)[number]) =>
    Math.hypot((a.lat - b.lat) * 111, (a.lon - b.lon) * 111 * Math.cos((a.lat * Math.PI) / 180)) <= epsKm
  const clusters: (typeof points)[] = []
  for (let i = 0; i < points.length; i++) {
    if (seen[i]) continue
    seen[i] = true
    const group = [points[i]!]
    for (let g = 0; g < group.length; g++) {
      for (let j = 0; j < points.length; j++) {
        if (!seen[j] && near(group[g]!, points[j]!)) {
          seen[j] = true
          group.push(points[j]!)
        }
      }
    }
    if (group.length >= minPts) clusters.push(group)
  }
  return clusters
}

export async function firmsClusters(bbox: [number, number, number, number]): Promise<FireCluster[]> {
  const key = process.env.FIRMS_MAP_KEY
  if (!key) return []
  const res = await tapedFetch('firms', `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_NOAA20_NRT/${bbox.join(',')}/1`)
  const [header, ...lines] = res.text().trim().split('\n')
  const cols = (header ?? '').split(',')
  const at = (name: string) => cols.indexOf(name)
  const points = lines
    .map((l) => l.split(','))
    .map((c) => ({
      lat: Number(c[at('latitude')]),
      lon: Number(c[at('longitude')]),
      frp: Number(c[at('frp')]),
      at: `${c[at('acq_date')]}T${String(c[at('acq_time')]).padStart(4, '0').replace(/(\d\d)(\d\d)/, '$1:$2')}:00Z`,
    }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
  return clusterFires(points).map((g) => {
    const lat = g.reduce((a, p) => a + p.lat, 0) / g.length
    const lon = g.reduce((a, p) => a + p.lon, 0) / g.length
    const first = g.map((p) => p.at).sort()[0]!
    return {
      count: g.length,
      event: base({
        id: `firms:${lat.toFixed(2)}:${lon.toFixed(2)}:${first.slice(0, 10)}`,
        type: 'wildfire',
        title: `Fire cluster, ${g.length} detections`,
        geometry: { type: 'Point', coordinates: [lon, lat] },
        severity: { count: g.length, frp_sum: Math.round(g.reduce((a, p) => a + p.frp, 0)) },
        sources: [{ name: 'NASA FIRMS (VIIRS NOAA-20)', id: first, url: 'https://firms.modaps.eosdis.nasa.gov/', published_at: first }],
      }),
    }
  })
}
