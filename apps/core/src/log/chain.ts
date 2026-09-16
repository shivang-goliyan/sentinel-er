import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  GENESIS_HASH,
  LogBody,
  canonicalJson,
  hashMaterial,
  type Actor,
  type LogEntry,
  type LogKind,
  type PayloadInput,
} from '@sentinel/shared'
import type { Bus } from '../bus.ts'

interface Row {
  seq: number
  ts: string
  run_id: string | null
  actor: string
  kind: string
  payload: string
  prev_hash: string
  hash: string
}

export interface VerifyResult {
  ok: boolean
  checked: number
  head_seq: number
  head_hash: string
  broken_at?: number
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

function toEntry(r: Row): LogEntry {
  return {
    seq: r.seq,
    ts: r.ts,
    run_id: r.run_id,
    actor: r.actor,
    kind: r.kind,
    payload: JSON.parse(r.payload),
    prev_hash: r.prev_hash,
    hash: r.hash,
  } as LogEntry
}

export class LogChain {
  private headStmt
  private insertStmt
  private afterStmt
  private allStmt
  private appendTx
  private bus: Bus

  constructor(sqlite: Database.Database, bus: Bus) {
    this.bus = bus
    this.headStmt = sqlite.prepare<[], { seq: number; hash: string }>('SELECT seq, hash FROM log ORDER BY seq DESC LIMIT 1')
    this.insertStmt = sqlite.prepare(
      'INSERT INTO log (seq, ts, run_id, actor, kind, payload, prev_hash, hash) VALUES (@seq, @ts, @run_id, @actor, @kind, @payload, @prev_hash, @hash)',
    )
    this.afterStmt = sqlite.prepare<[number, number], Row>('SELECT * FROM log WHERE seq > ? ORDER BY seq LIMIT ?')
    this.allStmt = sqlite.prepare<[], Row>('SELECT * FROM log ORDER BY seq')
    // read-head-then-insert in one transaction; with a single process this can't interleave anyway
    this.appendTx = sqlite.transaction((row: Row) => {
      const head = this.headStmt.get()
      row.seq = (head?.seq ?? 0) + 1
      row.prev_hash = head?.hash ?? GENESIS_HASH
      row.hash = sha256(hashMaterial(row.prev_hash, { ...row, payload: JSON.parse(row.payload) }))
      this.insertStmt.run(row)
      return row
    })
  }

  append<K extends LogKind>(actor: Actor, kind: K, payload: PayloadInput<K>, runId: string | null = null): LogEntry {
    const body = LogBody.parse({ kind, payload })
    // round-trip so what we hash is exactly what a reader will parse back
    const normalised = JSON.parse(JSON.stringify(body.payload))
    const row = this.appendTx({
      seq: 0,
      ts: new Date().toISOString(),
      run_id: runId,
      actor,
      kind,
      payload: canonicalJson(normalised),
      prev_hash: '',
      hash: '',
    })
    const entry = toEntry(row)
    this.bus.emit(entry)
    return entry
  }

  after(seq: number, limit = 500): LogEntry[] {
    return this.afterStmt.all(seq, limit).map(toEntry)
  }

  head(): { seq: number; hash: string } {
    return this.headStmt.get() ?? { seq: 0, hash: GENESIS_HASH }
  }

  verify(): VerifyResult {
    let prev = GENESIS_HASH
    let expectSeq = 1
    let checked = 0
    for (const r of this.allStmt.iterate()) {
      const recomputed = sha256(hashMaterial(prev, { ...r, payload: JSON.parse(r.payload) }))
      if (r.seq !== expectSeq || r.prev_hash !== prev || r.hash !== recomputed) {
        return { ok: false, checked, head_seq: r.seq, head_hash: r.hash, broken_at: r.seq }
      }
      prev = r.hash
      expectSeq++
      checked++
    }
    return { ok: true, checked, head_seq: checked, head_hash: prev }
  }
}
