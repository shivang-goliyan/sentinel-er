import { createRequire } from 'node:module'
import type Database from 'better-sqlite3'
import type { LogChain } from './chain.ts'

// What we need from OpenTimestamps; swapped for a fake in tests.
export interface Notary {
  stamp(digestHex: string): Promise<Buffer>
  // returns the new proof if it changed, and the bitcoin block once confirmed
  upgrade(proof: Buffer, digestHex: string): Promise<{ proof: Buffer | null; height: number | null }>
}

interface AnchorRow {
  id: number
  head_seq: number
  head_hash: string
  proof: string
  submitted_at: string
  confirmed_at: string | null
  block_height: number | null
}

// the library writes progress to stdout; keep it out of our logs
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log
  console.log = () => {}
  try {
    return await fn()
  } finally {
    console.log = log
  }
}

export function openTimestamps(): Notary {
  const require = createRequire(import.meta.url)
  let lib: any
  const ots = () => (lib ??= require('opentimestamps'))
  const detached = (hex: string) => ots().DetachedTimestampFile.fromHash(new (ots().Ops.OpSHA256)(), Buffer.from(hex, 'hex'))

  return {
    async stamp(digestHex) {
      const d = detached(digestHex)
      await quietly(() => ots().stamp(d))
      return Buffer.from(d.serializeToBytes())
    },
    async upgrade(proof, digestHex) {
      const d = ots().DetachedTimestampFile.deserialize(proof)
      const changed: boolean = await quietly(() => ots().upgrade(d))
      const verdict = await quietly(() => ots().verify(d, detached(digestHex), { ignoreBitcoinNode: true })).catch(() => ({}))
      const height = (verdict as { bitcoin?: { height?: number } })?.bitcoin?.height ?? null
      return { proof: changed ? Buffer.from(d.serializeToBytes()) : null, height }
    },
  }
}

export class Anchors {
  private sqlite: Database.Database
  private chain: LogChain
  private notary: Notary
  private busy = false

  constructor(sqlite: Database.Database, chain: LogChain, notary: Notary) {
    this.sqlite = sqlite
    this.chain = chain
    this.notary = notary
  }

  list(): Omit<AnchorRow, 'proof'>[] {
    return this.sqlite
      .prepare<[], AnchorRow>('SELECT * FROM anchors ORDER BY id DESC LIMIT 50')
      .all()
      .map(({ proof: _p, ...rest }) => rest)
  }

  proof(id: number): Buffer | null {
    const row = this.sqlite.prepare<[number], AnchorRow>('SELECT * FROM anchors WHERE id = ?').get(id)
    return row ? Buffer.from(row.proof, 'base64') : null
  }

  row(id: number) {
    return this.sqlite.prepare<[number], AnchorRow>('SELECT * FROM anchors WHERE id = ?').get(id) ?? null
  }

  // Anchors the current head, unless it's already anchored. Returns the new anchor id.
  async submit(runId: string | null = null): Promise<number | null> {
    if (this.busy) return null
    const head = this.chain.head()
    if (head.seq === 0) return null
    const last = this.sqlite.prepare<[], { head_seq: number }>('SELECT head_seq FROM anchors ORDER BY id DESC LIMIT 1').get()
    // the anchor.submitted entry itself moves the head by one; don't chase our own tail
    if (last && head.seq <= last.head_seq + 1) return null
    this.busy = true
    try {
      const proof = await this.notary.stamp(head.hash)
      const info = this.sqlite
        .prepare('INSERT INTO anchors (head_seq, head_hash, proof, submitted_at) VALUES (?, ?, ?, ?)')
        .run(head.seq, head.hash, proof.toString('base64'), new Date().toISOString())
      this.chain.append('system', 'anchor.submitted', { head_seq: head.seq, head_hash: head.hash }, runId)
      return Number(info.lastInsertRowid)
    } catch (err) {
      this.chain.append('system', 'error', { where: 'anchoring the log', message: (err as Error).message }, runId)
      return null
    } finally {
      this.busy = false
    }
  }

  async upgradePending() {
    const pending = this.sqlite.prepare<[], AnchorRow>('SELECT * FROM anchors WHERE confirmed_at IS NULL ORDER BY id').all()
    for (const row of pending) {
      try {
        const { proof, height } = await this.notary.upgrade(Buffer.from(row.proof, 'base64'), row.head_hash)
        if (proof) this.sqlite.prepare('UPDATE anchors SET proof = ? WHERE id = ?').run(proof.toString('base64'), row.id)
        if (height !== null) {
          this.sqlite
            .prepare('UPDATE anchors SET confirmed_at = ?, block_height = ? WHERE id = ?')
            .run(new Date().toISOString(), height, row.id)
          this.chain.append('system', 'anchor.confirmed', { head_seq: row.head_seq, block_height: height })
        }
      } catch {
        // calendars are flaky; the next pass tries again
      }
    }
  }

  // Does the log still hash to what we anchored?
  checkAgainstLog(id: number): { ok: boolean; head_seq: number; head_hash: string; log_hash: string | null } | null {
    const row = this.row(id)
    if (!row) return null
    const at = this.sqlite.prepare<[number], { hash: string }>('SELECT hash FROM log WHERE seq = ?').get(row.head_seq)
    const chainOk = this.chain.verify()
    const intact = chainOk.ok || (chainOk.broken_at ?? Infinity) > row.head_seq
    return { ok: intact && at?.hash === row.head_hash, head_seq: row.head_seq, head_hash: row.head_hash, log_hash: at?.hash ?? null }
  }
}
