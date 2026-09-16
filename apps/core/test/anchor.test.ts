import { describe, expect, it } from 'vitest'
import { canonicalJson } from '@sentinel/shared'
import { makeApp, makeDeps } from './helpers.ts'

describe('anchors', () => {
  it('anchors the current head', async () => {
    const d = makeDeps()
    d.chain.append('system', 'note', { text: 'a' })
    d.chain.append('system', 'note', { text: 'b' })
    const head = d.chain.head()
    const id = await d.anchors.submit()
    expect(id).not.toBeNull()
    expect(d.anchors.list()[0]).toMatchObject({ head_seq: head.seq, head_hash: head.hash })
    expect(d.chain.after(0).at(-1)?.kind).toBe('anchor.submitted')
  })

  it('skips when nothing is new', async () => {
    const d = makeDeps()
    d.chain.append('system', 'note', { text: 'a' })
    await d.anchors.submit()
    expect(await d.anchors.submit()).toBeNull()
  })

  it('records the bitcoin confirmation', async () => {
    const d = makeDeps()
    d.chain.append('system', 'note', { text: 'a' })
    const id = (await d.anchors.submit())!
    await d.anchors.upgradePending()
    expect(d.anchors.row(id)).toMatchObject({ block_height: 912345 })
    expect(d.anchors.proof(id)!.toString()).toMatch(/^bitcoin:/)
    expect(d.chain.after(0).some((e) => e.kind === 'anchor.confirmed')).toBe(true)
  })

  it('notices a rewritten history', async () => {
    const d = makeDeps()
    d.chain.append('system', 'note', { text: 'one' })
    d.chain.append('system', 'note', { text: 'two' })
    const id = (await d.anchors.submit())!
    expect(d.anchors.checkAgainstLog(id)?.ok).toBe(true)
    d.sqlite.exec('DROP TRIGGER log_no_update')
    d.sqlite.prepare('UPDATE log SET payload = ? WHERE seq = 1').run(canonicalJson({ text: 'edited' }))
    expect(d.anchors.checkAgainstLog(id)?.ok).toBe(false)
  })

  it('serves the proof file', async () => {
    const { app, chain, anchors } = await makeApp()
    chain.append('system', 'note', { text: 'x' })
    const id = await anchors.submit()
    const res = await app.inject({ method: 'GET', url: `/api/anchors/${id}/proof` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-disposition']).toContain('.ots')
    await app.close()
  })
})
