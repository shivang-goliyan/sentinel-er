import type Database from 'better-sqlite3'
import { haversineKm, readSeedIfThere } from '../geo/seeds.ts'

export const RAPT_SOURCE = 'FEMA Hospitals (RAPT copy of HIFLD)'
export const RAPT_URL = 'https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Hospitals_RAPT/FeatureServer/6'

// hospitals that run an emergency department in practice
const ACUTE = new Set(['GENERAL ACUTE CARE', 'CRITICAL ACCESS', 'CHILDREN', 'MILITARY'])

export interface HospitalProfile {
  id: string
  name: string
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  lat: number
  lon: number
  phone: string | null
  type: string
  beds: number | null
  trauma: string | null
  helipad: boolean | null
  website: string | null
  source_date: string | null
  dist_km?: number
}

type RaptRow = Record<string, string | number | null>
type Seed = { retrieved_at: string; rows: RaptRow[] }

const str = (v: unknown) => (v == null || v === '' || v === 'NOT AVAILABLE' ? null : String(v).trim())

const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s\-/(])([a-z])/g, (_m, pre: string, c: string) => pre + c.toUpperCase()).replace(/(?<!^)\b(Of|And|The|At)\b/g, (m) => m.toLowerCase())

export function traumaLabel(raw: string | null): string {
  if (!raw) return 'not designated in the FEMA data'
  const m = /LEVEL\s+(I{1,3}V?|IV|V)\b/.exec(raw)
  return m ? `Level ${m[1]}` : raw.toLowerCase()
}

function fromRapt(r: RaptRow): HospitalProfile | null {
  const lat = Number(r.LATITUDE)
  const lon = Number(r.LONGITUDE)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return {
    id: `rapt-${r.ID}`,
    name: titleCase(String(r.NAME ?? 'Unnamed hospital')),
    address: str(r.ADDRESS),
    city: str(r.CITY) ? titleCase(String(r.CITY)) : null,
    state: str(r.STATE),
    zip: str(r.ZIP),
    lat,
    lon,
    phone: str(r.TELEPHONE),
    type: String(r.TYPE ?? ''),
    beds: typeof r.BEDS === 'number' && r.BEDS > 0 ? r.BEDS : null,
    trauma: str(r.TRAUMA),
    helipad: r.HELIPAD === 'Y' ? true : r.HELIPAD === 'N' ? false : null,
    website: str(r.WEBSITE),
    source_date: str(r.SOURCEDATE),
  }
}

let seedCache: { retrieved_at: string; hospitals: HospitalProfile[] } | null = null
export function raptSeed() {
  if (!seedCache) {
    const s = readSeedIfThere<Seed>('hospitals-rapt-us.json') ?? readSeedIfThere<Seed>('hospitals-rapt-va-dc-md.json')
    seedCache = {
      retrieved_at: s?.retrieved_at ?? new Date(0).toISOString(),
      hospitals: (s?.rows ?? [])
        .filter((r) => r.STATUS === 'OPEN' && ACUTE.has(String(r.TYPE)))
        .map(fromRapt)
        .filter((h): h is HospitalProfile => h !== null),
    }
  }
  return seedCache
}

export function hospitalsNear(lon: number, lat: number, radiusKm: number, limit = 40): HospitalProfile[] {
  return raptSeed()
    .hospitals.map((h) => ({ ...h, dist_km: haversineKm(lon, lat, h.lon, h.lat) }))
    .filter((h) => h.dist_km <= radiusKm)
    .sort((a, b) => a.dist_km - b.dist_km)
    .slice(0, limit)
}

// CMS Hospital General Information and Provider of Services give the CCN, the ED flag and
// certified beds. data.cms.gov refuses this network, so the lookup runs on the US server from the
// cached national tables. Until those tables are in data/seeds this returns null.
export function cmsLookup(_h: HospitalProfile): { ccn: string; beds: number | null; has_ed: boolean | null } | null {
  return null
}

// Upsert profiles plus one provenance row per field.
export function saveProfiles(sqlite: Database.Database, hospitals: HospitalProfile[], retrievedAt: string) {
  const upsert = sqlite.prepare(`
    INSERT INTO hospitals (ccn, name, address, city, state, zip, lat, lon, phone_main, trauma_level, beds, website, updated_at)
    VALUES (@id, @name, @address, @city, @state, @zip, @lat, @lon, @phone, @trauma, @beds, @website, @now)
    ON CONFLICT(ccn) DO UPDATE SET name = excluded.name, address = excluded.address, city = excluded.city,
      state = excluded.state, zip = excluded.zip, lat = excluded.lat, lon = excluded.lon,
      phone_main = excluded.phone_main, trauma_level = excluded.trauma_level, beds = excluded.beds,
      website = excluded.website, updated_at = excluded.updated_at`)
  const field = sqlite.prepare(`
    INSERT INTO hospital_fields (ccn, field, value, source_name, source_url, confidence, retrieved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(ccn, field, source_name) DO UPDATE SET value = excluded.value, retrieved_at = excluded.retrieved_at`)
  const now = new Date().toISOString()
  sqlite.transaction(() => {
    for (const h of hospitals) {
      upsert.run({ ...h, now })
      const put = (name: string, value: unknown, confidence: number) =>
        field.run(h.id, name, JSON.stringify(value), RAPT_SOURCE, RAPT_URL, confidence, retrievedAt)
      put('name', h.name, 0.9)
      put('location', [h.lon, h.lat], 0.9)
      put('phone_main', h.phone, 0.7)
      put('beds', h.beds, 0.6)
      put('trauma_level', h.trauma, 0.4)
      put('helipad', h.helipad, 0.5)
      put('source_date', h.source_date, 1)
    }
  })()
}
