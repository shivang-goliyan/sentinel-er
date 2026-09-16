import type { FactSource } from '@sentinel/shared'
import type { FactStore } from '../facts/store.ts'
import type { LogChain } from '../log/chain.ts'
import { nearestSubstations, outageAt, restoreText, type Substation } from '../models/lifeline.ts'

export interface LifelineZip {
  zcta: string
  lon: number
  lat: number
  pgaG: number
  powerDependent: number | null
  oxygen: number | null
  ventilators: number | null
  masked: boolean
}

export interface LifelineRow {
  zcta: string
  probability: number
  atRisk: number
  restoreDays: number | null
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']
const SHOWN = 8
const MODEL_VERSION = 'lifeline-eq-1'

export function runLifelineStage(
  d: { chain: LogChain; facts: FactStore },
  runId: string,
  zips: LifelineZip[],
  substations: Omit<Substation, 'distKm'>[],
  empowerSource: FactSource,
): LifelineRow[] {
  const { chain, facts } = d
  const now = new Date().toISOString()
  const say = (text: string, state: 'working' | 'done' | 'blocked' = 'working') => chain.append('analyst', 'status', { text, state }, runId)
  const known = zips.filter((z) => (z.powerDependent ?? 0) > 0)
  if (!known.length) {
    say('No power-dependent counts for the affected ZIPs', 'blocked')
    return []
  }
  say(`Estimating outages for ${known.length} ZIP areas from ${substations.length} substations`)

  const modelSource: FactSource = {
    name: `Sentinel lifeline model (${MODEL_VERSION}; Hazus 6.1 substation and distribution-circuit curves, tables 8-29 and 8-30)`,
    retrieved_at: now,
    method: 'model',
  }

  const rows = known
    .map((z) => {
      const est = outageAt(z.pgaG, nearestSubstations(z.lon, z.lat, substations))
      return { z, est, atRisk: Math.round((z.powerDependent ?? 0) * est.probability) }
    })
    .sort((a, b) => b.atRisk - a.atRisk)

  const ids: Record<string, Record<string, string>> = {}
  rows.slice(0, SHOWN).forEach(({ z, est, atRisk }, i) => {
    const rank = ORDINALS[i] ?? 'next'
    const where = `the ${rank} ZIP area on the list`
    const put = (field: string, f: Parameters<FactStore['add']>[1]) => {
      const fact = facts.add(runId, { ...f, key: `zip.${z.zcta}.${field}` })
      ;(ids[z.zcta] ??= {})[field] = fact.id
    }
    put('code', { key: '', label: `ZIP code of ${where}`, value: z.zcta, unit: 'text', source: empowerSource })
    put('power_dependent', {
      key: '',
      label: `Residents on powered medical equipment in ${where}`,
      value: z.powerDependent!,
      unit: 'people',
      // HHS publishes any count from one to ten as eleven
      display: z.masked ? '≤11' : undefined,
      spoken: z.masked ? 'eleven or fewer' : undefined,
      source: empowerSource,
    })
    if (z.oxygen !== null) put('oxygen', { key: '', label: `Residents on home oxygen in ${where}`, value: z.oxygen, unit: 'people', source: empowerSource })
    if (z.ventilators !== null && z.ventilators > 0) {
      put('ventilators', { key: '', label: `Residents on home ventilators in ${where}`, value: z.ventilators, unit: 'people', source: empowerSource })
    }
    put('outage_probability', {
      key: '',
      label: `Chance of losing power in ${where}`,
      value: Math.round(est.probability * 100) / 100,
      unit: 'probability',
      tolerance: { abs: 0.01 },
      source: modelSource,
    })
    put('at_risk', { key: '', label: `Power-dependent residents likely to lose power in ${where}`, value: atRisk, unit: 'people', source: modelSource })
    if (est.restoreDays !== null) {
      const t = restoreText(est.restoreDays)
      put('restoration', {
        key: '',
        label: `Expected wait for power to return in ${where}, if it goes out`,
        value: Math.round(est.restoreDays * 10) / 10,
        unit: 'days',
        display: t.display,
        spoken: t.spoken,
        source: modelSource,
      })
    }
  })

  const total = rows.reduce((a, r) => a + r.atRisk, 0)
  facts.add(runId, {
    key: 'lifeline.total_at_risk',
    label: 'Power-dependent residents likely to lose power across the area',
    value: total,
    unit: 'people',
    source: modelSource,
  })
  facts.add(runId, { key: 'lifeline.zip_count', label: 'ZIP areas checked for power-dependent residents', value: known.length, unit: 'count', source: empowerSource })

  chain.append(
    'analyst',
    'model.output',
    {
      model: 'lifeline',
      version: MODEL_VERSION,
      outputs: {
        substations: substations.length,
        rows: rows.slice(0, SHOWN).map((r) => ({
          zcta: r.z.zcta,
          lon: r.z.lon,
          lat: r.z.lat,
          fact_ids: ids[r.z.zcta] ?? {},
          grid: Math.round(r.est.gridProbability * 100) / 100,
          street: Math.round(r.est.streetProbability * 100) / 100,
        })),
      },
    },
    runId,
  )
  chain.append('analyst', 'ledger', { milestone: 'lifeline_ready' }, runId)
  say('Lifeline estimate ready', 'done')
  return rows.map((r) => ({ zcta: r.z.zcta, probability: r.est.probability, atRisk: r.atRisk, restoreDays: r.est.restoreDays }))
}
