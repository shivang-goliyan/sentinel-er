import { tapedFetch, type TapedResponse } from '../tape.ts'

const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter']

export type PoiKind =
  | 'hospital'
  | 'clinic'
  | 'school'
  | 'shelter'
  | 'fire_station'
  | 'police'
  | 'nursing_home'
  | 'substation'

export interface Poi {
  osm: string
  kind: PoiKind
  name: string | null
  lon: number
  lat: number
  tags: Record<string, string>
}

export interface PoiQuery {
  lon: number
  lat: number
  // hazard zone: schools, shelters, fire, police, care homes
  zoneKm: number
  hospitalsKm: number
  substationsKm: number
}

const KEEP = ['name', 'operator', 'voltage', 'substation', 'emergency', 'beds', 'healthcare', 'social_facility', 'shelter_type', 'capacity']

export function buildQuery(q: PoiQuery): string {
  const at = (km: number) => `around:${Math.round(km * 1000)},${q.lat.toFixed(4)},${q.lon.toFixed(4)}`
  return `[out:json][timeout:90];
(
  nwr(${at(q.zoneKm)})[amenity~"^(school|fire_station|police|nursing_home)$"];
  nwr(${at(q.zoneKm)})[amenity=shelter][shelter_type~"^(emergency|public)$"];
  nwr(${at(q.zoneKm)})[social_facility~"^(nursing_home|assisted_living|shelter)$"];
  nwr(${at(q.hospitalsKm)})[amenity~"^(hospital|clinic)$"];
  nwr(${at(q.substationsKm)})[power=substation];
);
out center tags;`
}

function kindOf(tags: Record<string, string>): PoiKind | null {
  if (tags.power === 'substation') return 'substation'
  if (tags.social_facility === 'nursing_home' || tags.social_facility === 'assisted_living') return 'nursing_home'
  if (tags.social_facility === 'shelter') return 'shelter'
  const a = tags.amenity
  if (a === 'hospital' || a === 'clinic' || a === 'school' || a === 'shelter' || a === 'fire_station' || a === 'police' || a === 'nursing_home') {
    return a
  }
  return null
}

type Element = { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }

export function parseElements(elements: Element[]): Poi[] {
  const out: Poi[] = []
  for (const el of elements) {
    const tags = el.tags ?? {}
    const kind = kindOf(tags)
    const lat = el.lat ?? el.center?.lat
    const lon = el.lon ?? el.center?.lon
    if (!kind || lat == null || lon == null) continue
    const kept: Record<string, string> = {}
    for (const k of KEEP) if (tags[k]) kept[k] = tags[k]
    out.push({ osm: `${el.type}/${el.id}`, kind, name: tags.name ?? null, lon, lat, tags: kept })
  }
  return out
}

export interface PoiResult {
  pois: Poi[]
  url: string
  res: TapedResponse
}

// One query, sent to the main server and then a mirror. Overpass asks for no parallel scripts,
// so callers await this rather than fanning out.
export async function fetchPois(q: PoiQuery, opts: { refresh?: boolean } = {}): Promise<PoiResult> {
  const body = new URLSearchParams({ data: buildQuery(q) }).toString()
  const post = { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }, timeoutMs: 100_000 }
  // mapped schools and substations don't change between drills; a query answered once is replayed
  // from its tape unless a refresh is asked for (OVERPASS_REFRESH=1)
  if (!opts.refresh && process.env.OVERPASS_REFRESH !== '1') {
    try {
      const res = await tapedFetch('overpass', MIRRORS[0]!, { ...post, tape: 'replay' })
      const json = res.json<{ elements?: Element[] }>()
      if (json.elements) return { pois: parseElements(json.elements), url: MIRRORS[0]!, res }
    } catch {
      // no tape yet
    }
  }
  let lastError = ''
  for (const url of MIRRORS) {
    try {
      const res = await tapedFetch('overpass', url, post)
      if (res.status !== 200) {
        lastError = `${url} answered ${res.status}`
        continue
      }
      const json = res.json<{ elements?: Element[]; remark?: string }>()
      if (!json.elements) {
        lastError = `${url}: ${json.remark ?? 'no elements'}`
        continue
      }
      return { pois: parseElements(json.elements), url, res }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  throw new Error(`OpenStreetMap lookup failed: ${lastError}`)
}
