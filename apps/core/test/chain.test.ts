import { describe, expect, it } from 'vitest'
import { GENESIS_HASH, canonicalJson, hashMaterial, sha256Hex } from '@sentinel/shared'
import { makeDeps } from './helpers.ts'

describe('log chain', () => {
  it('links entries by hash', () => {
    const { chain } = makeDeps()
    const a = chain.append('system', 'note', { text: 'first' })
    const b = chain.append('operator', 'note', { text: 'second' })
    expect(a.seq).toBe(1)
    expect(a.prev_hash).toBe(GENESIS_HASH)
    expect(b.prev_hash).toBe(a.hash)
    expect(chain.verify()).toMatchObject({ ok: true, checked: 2, head_seq: 2 })
  })

  it('browser hash matches server', async () => {
    const { chain } = makeDeps()
    const e = chain.append('scout', 'status', { text: 'reading CMS' })
    const again = await sha256Hex(hashMaterial(e.prev_hash, e))
    expect(again).toBe(e.hash)
  })

  it('applies schema defaults before hashing', () => {
    const { chain } = makeDeps()
    const e = chain.append('scout', 'status', { text: 'x' })
    expect(e.payload).toEqual({ text: 'x', state: 'working' })
  })

  it('rejects malformed payloads', () => {
    const { chain } = makeDeps()
    expect(() => chain.append('system', 'ledger', { milestone: 'lunch' } as never)).toThrow()
    expect(chain.head().seq).toBe(0)
  })

  it('refuses updates and deletes', () => {
    const { chain, sqlite } = makeDeps()
    chain.append('system', 'note', { text: 'keep me' })
    expect(() => sqlite.prepare("UPDATE log SET payload = '{}'").run()).toThrow(/append-only/)
    expect(() => sqlite.prepare('DELETE FROM log').run()).toThrow(/append-only/)
  })

  it('catches tampering past the trigger', () => {
    const { chain, sqlite } = makeDeps()
    chain.append('system', 'note', { text: 'one' })
    chain.append('system', 'note', { text: 'two' })
    chain.append('system', 'note', { text: 'three' })
    sqlite.exec('DROP TRIGGER log_no_update')
    sqlite.prepare('UPDATE log SET payload = ? WHERE seq = 2').run(canonicalJson({ text: 'rewritten' }))
    expect(chain.verify()).toMatchObject({ ok: false, broken_at: 2, checked: 1 })
  })

  it('publishes appends on the bus', () => {
    const { chain, bus } = makeDeps()
    const seen: number[] = []
    bus.on((e) => seen.push(e.seq))
    chain.append('system', 'note', { text: 'a' })
    chain.append('system', 'note', { text: 'b' })
    expect(seen).toEqual([1, 2])
  })
})
