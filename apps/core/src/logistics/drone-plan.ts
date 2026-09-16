// A lawnmower survey over the worst-hit square, cut into sorties a battery can fly, written as a
// QGroundControl .plan (format: docs.qgroundcontrol.com, "Plan File Format").
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface SurveyParams {
  altitudeM: number
  // camera horizontal field of view
  hfovDeg: number
  sideOverlap: number
  speedMs: number
  enduranceMin: number
  // keep some battery back
  reserve: number
}

// A typical small mapping quadcopter. These are planning assumptions, shown with the plan.
export const DEFAULT_SURVEY: SurveyParams = {
  altitudeM: 120,
  hfovDeg: 70,
  sideOverlap: 0.3,
  speedMs: 12,
  enduranceMin: 25,
  reserve: 0.25,
}

type LatLon = [number, number]

const M_PER_DEG_LAT = 111_320
const mPerDegLon = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)

export function lineSpacingM(p: SurveyParams = DEFAULT_SURVEY) {
  const footprint = 2 * p.altitudeM * Math.tan(((p.hfovDeg / 2) * Math.PI) / 180)
  return footprint * (1 - p.sideOverlap)
}

function distM(a: LatLon, b: LatLon) {
  const dy = (a[0] - b[0]) * M_PER_DEG_LAT
  const dx = (a[1] - b[1]) * mPerDegLon((a[0] + b[0]) / 2)
  return Math.hypot(dx, dy)
}

export interface Survey {
  home: LatLon
  sorties: LatLon[][]
  spacingM: number
  lineKm: number
  areaKm2: number
}

// East-west passes across a square centred on `centre`, flown back and forth, split so each
// sortie (out, passes, home) fits the usable battery.
export function planSurvey(centre: LatLon, halfSideKm: number, p: SurveyParams = DEFAULT_SURVEY): Survey {
  const spacing = lineSpacingM(p)
  const half = halfSideKm * 1000
  const dLat = half / M_PER_DEG_LAT
  const dLon = half / mPerDegLon(centre[0])
  const rows = Math.max(1, Math.floor((2 * half) / spacing) + 1)
  const passes: [LatLon, LatLon][] = []
  for (let i = 0; i < rows; i++) {
    const lat = centre[0] - dLat + (i * 2 * dLat) / Math.max(1, rows - 1)
    const west: LatLon = [lat, centre[1] - dLon]
    const east: LatLon = [lat, centre[1] + dLon]
    passes.push(i % 2 === 0 ? [west, east] : [east, west])
  }

  // take off from the south-west corner, where a crew would stage
  const home: LatLon = [centre[0] - dLat, centre[1] - dLon]
  const budget = p.speedMs * p.enduranceMin * 60 * (1 - p.reserve)
  const sorties: LatLon[][] = []
  let current: LatLon[] = []
  let used = 0
  let at = home
  for (const [a, b] of passes) {
    const leg = distM(at, a) + distM(a, b)
    if (current.length && used + leg + distM(b, home) > budget) {
      sorties.push(current)
      current = []
      used = 0
      at = home
    }
    used += distM(at, a) + distM(a, b)
    current.push(a, b)
    at = b
  }
  if (current.length) sorties.push(current)
  const lineKm = passes.reduce((s, [a, b]) => s + distM(a, b), 0) / 1000
  return { home, sorties, spacingM: spacing, lineKm, areaKm2: (2 * halfSideKm) ** 2 }
}

export function toQgcPlan(home: LatLon, points: LatLon[], p: SurveyParams = DEFAULT_SURVEY) {
  let id = 1
  const item = (command: number, frame: number, params: (number | null)[]) => ({
    AMSLAltAboveTerrain: null,
    Altitude: p.altitudeM,
    AltitudeMode: 1,
    autoContinue: true,
    command,
    doJumpId: id++,
    frame,
    params,
    type: 'SimpleItem',
  })
  const items = [
    // MAV_CMD_NAV_TAKEOFF
    item(22, 3, [0, 0, 0, null, home[0], home[1], p.altitudeM]),
    // MAV_CMD_NAV_WAYPOINT, relative altitude
    ...points.map(([lat, lon]) => item(16, 3, [0, 0, 0, null, lat, lon, p.altitudeM])),
    // MAV_CMD_NAV_RETURN_TO_LAUNCH
    item(20, 2, [0, 0, 0, 0, 0, 0, 0]),
  ]
  return {
    fileType: 'Plan',
    geoFence: { circles: [], polygons: [], version: 2 },
    groundStation: 'QGroundControl',
    mission: {
      cruiseSpeed: 15,
      firmwareType: 12,
      globalPlanAltitudeMode: 1,
      hoverSpeed: p.speedMs,
      items,
      plannedHomePosition: [home[0], home[1], 0],
      vehicleType: 2,
      version: 2,
    },
    rallyPoints: { points: [], version: 2 },
    version: 1,
  }
}

export async function writePlan(dir: string, plan: unknown): Promise<number> {
  await mkdir(dir, { recursive: true })
  const text = `${JSON.stringify(plan, null, 2)}\n`
  await writeFile(join(dir, 'drone.plan'), text)
  return Buffer.byteLength(text)
}
