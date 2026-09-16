import type Database from 'better-sqlite3'
import { Fact, type Actor, type FactSource, type FactUnit } from '@sentinel/shared'
import type { LogChain } from '../log/chain.ts'

export interface NewFact {
  key: string
  label: string
  value: number | string
  unit: FactUnit
  display?: string
  spoken?: string
  tolerance?: { abs?: number; rel?: number }
  source: FactSource
}

interface FactRow {
  id: string
  run_id: string
  key: string
  label: string
  value: string
  unit: string
  display: string
  spoken: string
  tolerance: string
  source: string
  supersedes: string | null
  created_at: string
}

const fromRow = (r: FactRow): Fact =>
  Fact.parse({
    ...r,
    value: JSON.parse(r.value),
    tolerance: JSON.parse(r.tolerance),
    source: JSON.parse(r.source),
  })

export function defaultDisplay(value: number | string, unit: FactUnit): string {
  if (typeof value === 'string') return value
  if (unit === 'percent') return `${Math.round(value)}%`
  if (unit === 'probability') return `${Math.round(value * 100)}%`
  if (unit === 'mmi') return value.toFixed(1)
  if (unit === 'g') return `${value.toFixed(2)} g`
  if (unit === 'magnitude') return `M${value.toFixed(1)}`
  if (Number.isInteger(value)) return value.toLocaleString('en-US')
  return value.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

// Facts are immutable. A new value for a key is a new fact that points at the one it replaces.
export class FactStore {
  private insert
  private forRun
  private counters = new Map<string, number>()
  private cache = new Map<string, Map<string, Fact>>()
  private sqlite: Database.Database
  private chain: LogChain

  constructor(sqlite: Database.Database, chain: LogChain) {
    this.sqlite = sqlite
    this.chain = chain
    this.insert = sqlite.prepare(
      `INSERT INTO facts (id, run_id, key, label, value, unit, display, spoken, tolerance, source, supersedes, created_at)
       VALUES (@id, @run_id, @key, @label, @value, @unit, @display, @spoken, @tolerance, @source, @supersedes, @created_at)`,
    )
    this.forRun = sqlite.prepare<[string], FactRow>('SELECT * FROM facts WHERE run_id = ? ORDER BY created_at, rowid')
  }

  private load(runId: string): Map<string, Fact> {
    let byId = this.cache.get(runId)
    if (byId) return byId
    byId = new Map()
    for (const r of this.forRun.all(runId)) byId.set(r.id, fromRow(r))
    this.cache.set(runId, byId)
    this.counters.set(runId, byId.size)
    return byId
  }

  add(runId: string, f: NewFact, actor: Actor = 'analyst'): Fact {
    const byId = this.load(runId)
    const n = (this.counters.get(runId) ?? 0) + 1
    this.counters.set(runId, n)
    const previous = this.byKey(runId, f.key)
    const display = f.display ?? defaultDisplay(f.value, f.unit)
    const fact = Fact.parse({
      id: `F${n.toString(36)}`,
      run_id: runId,
      key: f.key,
      label: f.label,
      value: f.value,
      unit: f.unit,
      display,
      spoken: f.spoken ?? display,
      tolerance: f.tolerance ?? {},
      source: f.source,
      supersedes: previous?.id ?? null,
      created_at: new Date().toISOString(),
    })
    this.insert.run({
      ...fact,
      value: JSON.stringify(fact.value),
      tolerance: JSON.stringify(fact.tolerance),
      source: JSON.stringify(fact.source),
    })
    byId.set(fact.id, fact)
    this.chain.append(actor, 'fact', { fact }, runId)
    return fact
  }

  get(runId: string, id: string): Fact | undefined {
    return this.load(runId).get(id)
  }

  all(runId: string): Fact[] {
    return [...this.load(runId).values()]
  }

  // the current value for every key
  latest(runId: string): Fact[] {
    const replaced = new Set<string>()
    const facts = this.all(runId)
    for (const f of facts) if (f.supersedes) replaced.add(f.supersedes)
    return facts.filter((f) => !replaced.has(f.id))
  }

  byKey(runId: string, key: string): Fact | undefined {
    let found: Fact | undefined
    for (const f of this.load(runId).values()) if (f.key === key) found = f
    return found
  }

  byPrefix(runId: string, prefix: string): Fact[] {
    return this.latest(runId).filter((f) => f.key.startsWith(prefix))
  }
}
