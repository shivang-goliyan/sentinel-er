import type { FactSource } from '@sentinel/shared'
import type { FactStore } from '../facts/store.ts'
import type { LogChain } from '../log/chain.ts'
import { driveMinutes as osrmDrive, type DriveResult } from '../models/drive.ts'
import { occupancyFor } from '../models/occupancy.ts'
import { DEFAULT_PARAMS, forecastSurge, hoursMinutes, type SurgeHospital, type SurgeRow } from '../models/surge.ts'

export interface SurgeCandidate {
  id: string
  name: string
  lat: number
  lon: number
  zip: string | null
  state: string | null
  beds: number | null
  pgaG: number
}

export interface SurgeStageDeps {
  chain: LogChain
  facts: FactStore
  drive?: (from: { lon: number; lat: number }, to: { lon: number; lat: number }[]) => Promise<DriveResult>
}

const MODEL_VERSION = 'surge-1'
const SHOWN = 8
// voice reads labels aloud and the verifier would trip over a digit in a name
const safe = (s: string) => s.replace(/\d+/g, '').replace(/\s{2,}/g, ' ').trim()

export async function runSurgeStage(
  d: SurgeStageDeps,
  runId: string,
  candidates: SurgeCandidate[],
  centre: { lon: number; lat: number },
  reserved: Record<string, number> = {},
): Promise<SurgeRow[]> {
  const { chain, facts } = d
  const say = (text: string, state: 'working' | 'done' | 'blocked' = 'working') => chain.append('analyst', 'status', { text, state }, runId)
  const p10 = facts.byKey(runId, 'casualty.injured.p10')
  const p50 = facts.byKey(runId, 'casualty.injured.p50')
  const p90 = facts.byKey(runId, 'casualty.injured.p90')
  if (!p50 || typeof p50.value !== 'number') {
    say('No casualty estimate yet, so no surge forecast', 'blocked')
    return []
  }
  const usable = candidates.filter((c) => (c.beds ?? 0) > 0)
  if (!usable.length) {
    say('No hospitals with known bed counts in range', 'blocked')
    return []
  }

  say(`Working out drive times to ${usable.length} hospitals`)
  const drive = await (d.drive ?? osrmDrive)(centre, usable)
  const now = new Date().toISOString()
  const surgeSource: FactSource = {
    name: `Sentinel surge model (${MODEL_VERSION}; arrivals after Chen et al. 2001; Hazus C2M building assumption)`,
    retrieved_at: now,
    method: 'model',
  }

  const hospitals: SurgeHospital[] = usable.map((c, i) => {
    const occ = occupancyFor(c.name, c.zip, c.state)
    // two public bed counts can disagree; plan against the smaller one
    const beds = occ.hhsBeds ? Math.min(c.beds!, occ.hhsBeds) : c.beds!
    const name = safe(c.name)
    facts.add(runId, {
      key: `hospital.${c.id}.occupancy`,
      label: `Usual bed occupancy at ${name}`,
      value: Math.round(occ.value * 100),
      unit: 'percent',
      tolerance: { abs: 1 },
      source: { name: occ.sourceName, url: occ.sourceUrl, retrieved_at: now, method: 'dataset' },
    })
    return { id: c.id, name: c.name, lat: c.lat, lon: c.lon, beds, occupancy: occ.value, driveMin: drive.minutes[i]!, pgaG: c.pgaG }
  })

  const injured = {
    p10: typeof p10?.value === 'number' ? p10.value : p50.value,
    p50: p50.value,
    p90: typeof p90?.value === 'number' ? p90.value : p50.value,
  }
  const rows = forecastSurge(hospitals, injured, reserved, DEFAULT_PARAMS)
  const byId = new Map(hospitals.map((h) => [h.id, h]))
  const ids: Record<string, Record<string, string>> = {}

  for (const r of rows.slice(0, SHOWN)) {
    const name = safe(r.name)
    const add = (field: string, label: string, value: number | string, unit: Parameters<FactStore['add']>[1]['unit'], extra: Partial<Parameters<FactStore['add']>[1]> = {}) => {
      const f = facts.add(runId, { key: `surge.${r.id}.${field}`, label, value, unit, source: surgeSource, ...extra })
      ;(ids[r.id] ??= {})[field] = f.id
      return f
    }
    add('share', `Share of expected casualties heading to ${name}`, Math.round(r.share * 100), 'percent', { tolerance: { abs: 1 } })
    add('capacity', `Surge-ready beds at ${name}`, r.capacity, 'beds')
    add('arrivals_3h', `Expected arrivals at ${name} within three hours`, r.arrivals.h3, 'people')
    add('arrivals_6h', `Expected arrivals at ${name} within six hours`, r.arrivals.h6, 'people')
    add('drive', `Drive time from the damage zone to ${name}`, Math.round(byId.get(r.id)!.driveMin), 'minutes', {
      source: {
        name: drive.source === 'osrm' ? 'OSRM demo server (OpenStreetMap)' : 'Straight-line estimate at city speed',
        retrieved_at: now,
        method: 'computed',
      },
    })
    if (r.minutes.p50 !== null) {
      const t = hoursMinutes(r.minutes.p50)
      add('minutes_to_full', `Time until ${name} runs out of surge beds`, r.minutes.p50, 'minutes', { display: t.display, spoken: t.spoken })
    } else {
      add('minutes_to_full', `Time until ${name} runs out of surge beds`, 'not within three days', 'text')
    }
    if (r.minutes.p10 !== null) {
      const t = hoursMinutes(r.minutes.p10)
      add('minutes_to_full_early', `Earliest time ${name} could fill, high casualty estimate`, r.minutes.p10, 'minutes', {
        display: t.display,
        spoken: t.spoken,
      })
    }
    if (r.divertTo) add('divert_to', `Divert partner for ${name}`, safe(byId.get(r.divertTo)!.name), 'text')
  }

  const first = rows.find((r) => r.minutes.p50 !== null)
  if (first) {
    facts.add(runId, { key: 'surge.first.name', label: 'Hospital expected to fill first', value: safe(first.name), unit: 'text', source: surgeSource })
  }

  chain.append(
    'analyst',
    'model.output',
    {
      model: 'surge',
      version: MODEL_VERSION,
      outputs: {
        drive_source: drive.source,
        params: { ...DEFAULT_PARAMS },
        rows: rows.slice(0, SHOWN).map((r) => ({ id: r.id, name: r.name, fact_ids: ids[r.id] ?? {} })),
      },
    },
    runId,
  )
  chain.append('analyst', 'ledger', { milestone: 'surge_forecast' }, runId)
  say(first ? `Surge forecast ready: ${safe(first.name)} fills first` : 'Surge forecast ready: no hospital fills within three days', 'done')
  return rows
}
