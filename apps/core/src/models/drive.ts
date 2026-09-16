import { haversineKm } from '../geo/seeds.ts'
import { tapedFetch } from '../tape.ts'

export interface DriveResult {
  minutes: number[]
  source: 'osrm' | 'straight-line'
}

// Plain drive times from one point to many (no hazard avoidance; that's the routing module's job).
// Falls back to straight-line distance at city speeds if the demo server is unhappy.
export async function driveMinutes(from: { lon: number; lat: number }, to: { lon: number; lat: number }[]): Promise<DriveResult> {
  if (!to.length) return { minutes: [], source: 'osrm' }
  const coords = [from, ...to].map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(';')
  try {
    const res = await tapedFetch('osrm', `https://router.project-osrm.org/table/v1/driving/${coords}?sources=0&annotations=duration`, {
      timeoutMs: 20_000,
    })
    const body = res.json<{ code?: string; durations?: (number | null)[][] }>()
    const row = body.durations?.[0]
    if (body.code === 'Ok' && row && row.length === to.length + 1) {
      return {
        minutes: row.slice(1).map((s, i) => (s === null ? straight(from, to[i]!) : s / 60)),
        source: 'osrm',
      }
    }
  } catch {
    // fall through
  }
  return { minutes: to.map((p) => straight(from, p)), source: 'straight-line' }
}

// 1.4 detour factor at 40 km/h: rough, and labelled as such wherever it's used
function straight(a: { lon: number; lat: number }, b: { lon: number; lat: number }) {
  return (haversineKm(a.lon, a.lat, b.lon, b.lat) * 1.4 * 60) / 40
}
