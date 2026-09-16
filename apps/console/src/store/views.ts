import type { Fact, Finding, PayloadOf } from '@sentinel/shared'
import { factRef, type ConsoleState, type Stamped } from './fold'

// Derived views for the horizon panels and drawers. They only pick facts and log entries apart;
// nothing here invents a number.

type ModelOutput = Stamped<PayloadOf<'model.output'>>

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const asStr = (v: unknown) => (typeof v === 'string' ? v : undefined)
const asNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export function latestOutput(models: ModelOutput[], runId: string | null, model: string): ModelOutput | null {
  if (!runId) return null
  return models.findLast((m) => m.run_id === runId && m.model === model) ?? null
}

function byKey(s: Pick<ConsoleState, 'facts' | 'latestFactByKey'>, runId: string, key: string): Fact | undefined {
  const ref = s.latestFactByKey[`${runId}:${key}`]
  return ref ? s.facts[ref] : undefined
}

function byId(s: Pick<ConsoleState, 'facts'>, runId: string, id: string | undefined): Fact | undefined {
  return id ? s.facts[factRef(runId, id)] : undefined
}

// string ids from a model row's fact_ids, ignoring anything malformed
function idMap(v: unknown): Record<string, string> {
  if (!isObj(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, id] of Object.entries(v)) if (typeof id === 'string') out[k] = id
  return out
}

// --- casualties --------------------------------------------------------------

export type Band = { p10?: Fact; p50?: Fact; p90?: Fact; planning?: Fact }
export type Contribution = { feature: string; name: string; value: number }

export type CasualtyView = {
  deaths: Band
  injured: Band
  contributions: Contribution[]
  priorDeaths: number | null
  variant: string | null
}

const ROMAN = ['0', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII']

const FEATURES: Record<string, string> = {
  log_global_expected: 'Size of physical estimate',
  country_factor: "Country's past quake record",
  region_factor: "Region's past quake record",
  magnitude: 'Magnitude',
  depth_km: 'Depth',
  hour_sin: 'Time of day',
  hour_cos: 'Time of day',
  is_night: 'Night-time',
  income_class: 'Country income class',
  log_gdp_per_capita: 'Income per person',
  pager_alert: 'USGS PAGER alert level',
}

export function featureName(feature: string): string {
  const mmi = /^log_pop_mmi(\d+)$/.exec(feature)
  if (mmi) return `People in shaking level ${ROMAN[Number(mmi[1])] ?? mmi[1]}`
  return FEATURES[feature] ?? feature.replace(/^log_/, '').replace(/_/g, ' ')
}

function band(s: Pick<ConsoleState, 'facts' | 'latestFactByKey'>, runId: string, target: string): Band {
  const get = (q: string) => byKey(s, runId, `casualty.${target}.${q}`)
  return { p10: get('p10'), p50: get('p50'), p90: get('p90'), planning: get('planning') }
}

const hasAny = (b: Band) => !!(b.p10 || b.p50 || b.p90 || b.planning)

export function casualtyView(
  s: Pick<ConsoleState, 'facts' | 'latestFactByKey' | 'models'>,
  runId: string | null,
  top = 3,
): CasualtyView | null {
  if (!runId) return null
  const deaths = band(s, runId, 'deaths')
  const injured = band(s, runId, 'injured')
  if (!hasAny(deaths) && !hasAny(injured)) return null

  const out = latestOutput(s.models, runId, 'casualty')?.outputs
  const explain = isObj(out?.explain) ? out.explain : undefined
  const raw = Array.isArray(explain?.contributions) ? explain.contributions : []
  const contributions = raw
    .flatMap((c) => {
      const feature = isObj(c) ? asStr(c.feature) : undefined
      const value = isObj(c) ? asNum(c.contribution_log1p) : undefined
      return feature && value !== undefined ? [{ feature, name: featureName(feature), value }] : []
    })
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, top)
  const model = isObj(out?.model) ? out.model : undefined

  return {
    deaths,
    injured,
    contributions,
    priorDeaths: asNum(out?.prior_deaths) ?? null,
    variant: asStr(model?.variant) ?? null,
  }
}

const numeric = (f: Fact | undefined) => (typeof f?.value === 'number' ? f.value : null)

export function bandValues(b: Band): { p10: number; p50: number; p90: number } | null {
  const [p10, p50, p90] = [numeric(b.p10), numeric(b.p50), numeric(b.p90)]
  return p10 === null || p50 === null || p90 === null ? null : { p10, p50, p90 }
}

// --- surge -----------------------------------------------------------------------

export type SurgeRow = {
  id: string
  name: string
  ids: Partial<Record<'share' | 'capacity' | 'arrivals_3h' | 'arrivals_6h' | 'drive' | 'minutes_to_full' | 'minutes_to_full_early' | 'divert_to', string>>
  fillsFirst: boolean
  fills: boolean
}

export function surgeRows(s: Pick<ConsoleState, 'facts' | 'models'>, runId: string | null): SurgeRow[] {
  const out = latestOutput(s.models, runId, 'surge')?.outputs
  if (!runId || !Array.isArray(out?.rows)) return []
  let firstTaken = false
  return out.rows.flatMap((r) => {
    if (!isObj(r)) return []
    const id = asStr(r.id)
    const name = asStr(r.name)
    if (!id || !name) return []
    const ids = idMap(r.fact_ids)
    // same rule as the surge stage: the first row with a real time to full is the one that fills first
    const fills = typeof byId(s, runId, ids.minutes_to_full)?.value === 'number'
    const fillsFirst = fills && !firstTaken
    if (fillsFirst) firstTaken = true
    return [{ id, name, ids, fills, fillsFirst }]
  })
}

// --- lifeline ----------------------------------------------------------------------

export type LifelineRow = {
  zcta: string
  ids: Partial<Record<'code' | 'power_dependent' | 'oxygen' | 'ventilators' | 'outage_probability' | 'at_risk' | 'restoration', string>>
  outage: number | null
}

export type LifelineView = {
  rows: LifelineRow[]
  totalId: string | null
  zipCountId: string | null
}

export function lifelineView(s: Pick<ConsoleState, 'facts' | 'latestFactByKey' | 'models'>, runId: string | null): LifelineView | null {
  if (!runId) return null
  const out = latestOutput(s.models, runId, 'lifeline')?.outputs
  const rows: LifelineRow[] = Array.isArray(out?.rows)
    ? out.rows.flatMap((r) => {
        if (!isObj(r)) return []
        const zcta = asStr(r.zcta)
        if (!zcta) return []
        const ids = idMap(r.fact_ids)
        const p = byId(s, runId, ids.outage_probability)?.value
        return [{ zcta, ids, outage: typeof p === 'number' ? Math.min(1, Math.max(0, p)) : null }]
      })
    : []
  const total = byKey(s, runId, 'lifeline.total_at_risk')
  const count = byKey(s, runId, 'lifeline.zip_count')
  if (!rows.length && !total) return null
  return { rows, totalId: total?.id ?? null, zipCountId: count?.id ?? null }
}

// --- sitrep checks ------------------------------------------------------------------

export type CheckFinding = {
  kind: Finding['kind']
  wrote: string
  line?: string
  expected?: string
  about?: string
  sourceName?: string
  sourceUrl?: string
  injected: boolean
}

export type SitrepCheck = {
  seq: number
  ts: string
  verdict: 'pass' | 'block'
  attempt: number | null
  template: boolean
  injected: string | null
  findings: CheckFinding[]
}

const plain = (t: string) => t.replace(/[,\s]/g, '')

// the draft line a finding came from, trimmed to something that fits on one row
export function lineWith(text: string | undefined, needle: string, room = 110): string | undefined {
  if (!text || !needle) return undefined
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(^|[^\\w.,])${esc}(?![\\w])`)
  const line = text.split('\n').find((l) => re.test(l))
  if (!line) return undefined
  const clean = line.trim().replace(/^[-*•]\s+/, '').replace(/^#+\s+/, '')
  if (clean.length <= room) return clean
  const at = clean.indexOf(needle)
  const from = Math.max(0, Math.min(at - Math.floor(room / 2), clean.length - room))
  return `${from > 0 ? '…' : ''}${clean.slice(from, from + room)}${from + room < clean.length ? '…' : ''}`
}

export function sitrepChecks(s: Pick<ConsoleState, 'verify' | 'faults' | 'facts'>, runId: string | null): SitrepCheck[] {
  if (!runId) return []
  const checks = s.verify.filter((v) => v.run_id === runId && v.channel === 'sitrep')
  const faults = s.faults.filter((f) => f.run_id === runId)

  // a fault is spliced into the next draft, so it belongs to the first block after it
  const faultFor = new Map<number, (typeof faults)[number]>()
  for (const f of faults) {
    const hit = checks.find((c) => c.seq > f.seq && c.verdict === 'block' && !faultFor.has(c.seq))
    if (hit) faultFor.set(hit.seq, f)
  }

  return checks.map((c) => {
    const draft = /draft\s+(\d+)/i.exec(c.target)
    const fault = faultFor.get(c.seq)
    const wrong = fault ? (/replaced with\s+(\S+?)\.?$/.exec(fault.detail)?.[1] ?? null) : null
    const findings: CheckFinding[] =
      c.verdict === 'block'
        ? c.findings.map((f) => ({
            kind: f.kind,
            wrote: f.text,
            line: lineWith(c.text, f.text),
            expected: f.expected,
            about: byId(s, runId, f.fact_id)?.label,
            sourceName: f.source?.name,
            sourceUrl: f.source?.url,
            injected: f.kind === 'injected' || (wrong !== null && plain(f.text) === plain(wrong)),
          }))
        : []
    return {
      seq: c.seq,
      ts: c.ts,
      verdict: c.verdict,
      attempt: draft ? Number(draft[1]) : null,
      template: /template/i.test(c.target),
      injected: fault?.detail ?? null,
      findings,
    }
  })
}

// --- files ------------------------------------------------------------------------------

export function runArtifacts(artifacts: ConsoleState['artifacts'], runId: string | null) {
  if (!runId) return []
  const latest = new Map<string, ConsoleState['artifacts'][number]>()
  for (const a of artifacts) if (a.run_id === runId) latest.set(`${a.type}:${a.name}`, a)
  return [...latest.values()]
}
