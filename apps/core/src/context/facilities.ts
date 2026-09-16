import type { Poi } from './overpass.ts'

export interface CareFacility {
  id: string
  kind: 'nursing_home'
  name: string | null
  lon: number
  lat: number
  source: string
  source_url: string
  note: string
}

// CMS nursing-home Provider Information has certified beds and coordinates, but data.cms.gov
// refuses this network. Until the US server caches it, nursing homes come from OpenStreetMap and
// are labelled as such. The console must never present these as the CMS list.
export const CMS_FACILITIES_STATUS =
  'CMS nursing-home data needs the US server; using OpenStreetMap care homes for now (incomplete, no bed counts)'

export function careHomesFromOsm(pois: Poi[]): CareFacility[] {
  return pois
    .filter((p) => p.kind === 'nursing_home')
    .map((p) => ({
      id: `osm-${p.osm.replace('/', '-')}`,
      kind: 'nursing_home' as const,
      name: p.name,
      lon: p.lon,
      lat: p.lat,
      source: 'OpenStreetMap (interim, not CMS)',
      source_url: `https://www.openstreetmap.org/${p.osm}`,
      note: 'no bed count in OpenStreetMap',
    }))
}

export function cmsNursingHomes(): CareFacility[] {
  return []
}
