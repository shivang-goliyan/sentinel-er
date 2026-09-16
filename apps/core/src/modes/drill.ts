import { randomBytes } from 'node:crypto'
import type { HazardEvent } from '@sentinel/shared'
import { DEFAULT_DRILL } from './drill-point.ts'

export interface DrillInput {
  lat?: number
  lon?: number
  mag?: number
  depth_km?: number
  at?: string
}

const place = (lat: number, lon: number) =>
  Math.abs(lat - DEFAULT_DRILL.lat) < 0.05 && Math.abs(lon - DEFAULT_DRILL.lon) < 0.05
    ? 'near Alexandria, Virginia'
    : `at ${lat.toFixed(3)}, ${lon.toFixed(3)}`

export function drillEvent(input: DrillInput = {}): HazardEvent {
  const lat = input.lat ?? DEFAULT_DRILL.lat
  const lon = input.lon ?? DEFAULT_DRILL.lon
  const mag = input.mag ?? DEFAULT_DRILL.mag
  const depth = input.depth_km ?? DEFAULT_DRILL.depth_km
  const now = new Date().toISOString()
  const origin = input.at ?? now
  const id = `drill-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`
  return {
    id,
    type: 'earthquake',
    title: `DRILL · M${mag.toFixed(1)} ${place(lat, lon)}`,
    tz: DEFAULT_DRILL.tz,
    geometry: { type: 'Point', coordinates: [lon, lat, depth] },
    severity: { mag, depth_km: depth, pager_alert: null, mmi_max: null, origin_time: origin },
    sources: [{ name: 'Drill injector', id, published_at: now }],
    detected_at: now,
    ingested_at: now,
    tier: 2,
    status: 'active',
    is_drill: true,
  }
}
