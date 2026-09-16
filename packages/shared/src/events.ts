import { z } from 'zod'

export const HazardType = z.enum([
  'earthquake',
  'wildfire',
  'flood',
  'cyclone',
  'volcano',
  'drought',
  'space_weather',
  'natural',
])
export type HazardType = z.infer<typeof HazardType>

export const Geometry = z.object({
  type: z.enum(['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon']),
  coordinates: z.any(),
})
export type Geometry = z.infer<typeof Geometry>

export const EventSource = z.object({
  name: z.string(),
  id: z.string(),
  url: z.string().optional(),
  published_at: z.string().optional(),
})

export const QuakeSeverity = z.object({
  mag: z.number(),
  depth_km: z.number(),
  pager_alert: z.enum(['green', 'yellow', 'orange', 'red']).nullable().optional(),
  mmi_max: z.number().nullable().optional(),
  origin_time: z.string(),
})

export const HazardEvent = z.object({
  id: z.string(),
  type: HazardType,
  title: z.string(),
  // IANA zone for the event-local clock
  tz: z.string().optional(),
  geometry: Geometry,
  // typed per hazard at the edges; QuakeSeverity for earthquakes
  severity: z.record(z.string(), z.unknown()),
  sources: z.array(EventSource),
  detected_at: z.string(),
  ingested_at: z.string(),
  tier: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  status: z.enum(['watch', 'active', 'closed']),
  is_drill: z.boolean(),
})
export type HazardEvent = z.infer<typeof HazardEvent>

export const RunMode = z.enum(['drill', 'live', 'replay', 'rerun', 'time_machine', 'any_hospital'])
export type RunMode = z.infer<typeof RunMode>

export const Milestone = z.enum([
  'detected',
  'context_built',
  'casualties_estimated',
  'surge_forecast',
  'lifeline_ready',
  'sitrep_written',
  'verified',
  'approved',
  'call_placed',
  'acknowledged',
])
export type Milestone = z.infer<typeof Milestone>

export const Actor = z.enum([
  'orchestrator',
  'scout',
  'analyst',
  'logistics',
  'comms',
  'verifier',
  'feeds',
  'operator',
  'system',
])
export type Actor = z.infer<typeof Actor>

// the order the console shows the crew in
export const CREW: Actor[] = ['orchestrator', 'scout', 'analyst', 'logistics', 'comms', 'verifier', 'feeds']

export const CallRole = z.enum(['charge_nurse', 'public', 'lifeline_county', 'lifeline_dme', 'switchboard'])
export type CallRole = z.infer<typeof CallRole>
