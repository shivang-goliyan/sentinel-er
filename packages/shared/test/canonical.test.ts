import { describe, expect, it } from 'vitest'
import { canonicalJson, hashMaterial, maskPhone, sha256Hex, GENESIS_HASH } from '../src/index.ts'
import { LogBody } from '../src/log.ts'

describe('canonicalJson', () => {
  it('ignores key insertion order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
  })

  it('drops undefined object values', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}')
  })

  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
  })
})

describe('hashing', () => {
  it('matches a known sha256', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('changes when payload changes', async () => {
    const base = { seq: 1, ts: '2026-09-16T00:00:00.000Z', run_id: null, actor: 'system', kind: 'note' }
    const a = await sha256Hex(hashMaterial(GENESIS_HASH, { ...base, payload: { text: 'x' } }))
    const b = await sha256Hex(hashMaterial(GENESIS_HASH, { ...base, payload: { text: 'y' } }))
    expect(a).not.toBe(b)
  })
})

describe('log schema', () => {
  it('rejects unknown kinds', () => {
    expect(LogBody.safeParse({ kind: 'nope', payload: {} }).success).toBe(false)
  })

  it('fills status defaults', () => {
    const parsed = LogBody.parse({ kind: 'status', payload: { text: 'looking' } })
    expect(parsed.payload).toEqual({ text: 'looking', state: 'working' })
  })
})

it('masks all but last four', () => {
  expect(maskPhone('+15715550123')).toBe('••• ••• 0123')
})
