import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import type { LogEntry } from '@sentinel/shared'
import { PASS, makeApp } from './helpers.ts'

type App = Awaited<ReturnType<typeof makeApp>>
let current: App | null = null
afterEach(async () => {
  await current?.app.close()
  current = null
})

async function app(extra: Record<string, string> = {}) {
  current = await makeApp(extra)
  return current
}

describe('operator routes', () => {
  it('rejects a missing passcode', async () => {
    const { app: a } = await app()
    const res = await a.inject({ method: 'POST', url: '/api/operator/note', payload: { text: 'hi' } })
    expect(res.statusCode).toBe(401)
  })

  it('appends a note when authorised', async () => {
    const { app: a, chain } = await app()
    const res = await a.inject({
      method: 'POST',
      url: '/api/operator/note',
      headers: { 'x-operator': PASS },
      payload: { text: 'rehearsal one' },
    })
    expect(res.statusCode).toBe(200)
    expect(chain.after(0)[0]).toMatchObject({ actor: 'operator', kind: 'note', payload: { text: 'rehearsal one' } })
  })

  it('locks out repeated wrong passcodes', async () => {
    const { app: a } = await app()
    for (let i = 0; i < 10; i++) {
      await a.inject({ method: 'POST', url: '/api/operator/check', headers: { 'x-operator': 'nope' } })
    }
    const res = await a.inject({ method: 'POST', url: '/api/operator/check', headers: { 'x-operator': PASS } })
    expect(res.statusCode).toBe(429)
  })

  it('flips the approval switch once', async () => {
    const { app: a, chain } = await app()
    const flip = (on: boolean) =>
      a.inject({ method: 'POST', url: '/api/switch/approval', headers: { 'x-operator': PASS }, payload: { on } })
    await flip(false)
    await flip(false)
    const state = await a.inject({ method: 'GET', url: '/api/state' })
    expect(state.json()).toMatchObject({ approval_on: false, drill_on: true, mode: 'drill' })
    expect(chain.after(0).filter((e) => e.kind === 'switch.changed')).toHaveLength(1)
  })
})

describe('log routes', () => {
  it('pages entries after a seq', async () => {
    const { app: a, chain } = await app()
    for (let i = 0; i < 5; i++) chain.append('system', 'note', { text: `n${i}` })
    const res = await a.inject({ method: 'GET', url: '/api/log?after=2&limit=2' })
    const body = res.json() as { entries: LogEntry[]; head: number }
    expect(body.entries.map((e) => e.seq)).toEqual([3, 4])
    expect(body.head).toBe(5)
  })

  it('rejects oversized pages', async () => {
    const { app: a } = await app()
    const res = await a.inject({ method: 'GET', url: '/api/log?limit=5000' })
    expect(res.statusCode).toBe(400)
  })

  it('reports an intact chain', async () => {
    const { app: a, chain } = await app()
    chain.append('system', 'note', { text: 'x' })
    const res = await a.inject({ method: 'GET', url: '/api/log/verify' })
    expect(res.json()).toMatchObject({ ok: true, checked: 1 })
  })
})

describe('event stream', () => {
  it('replays backlog then streams live', async () => {
    const { app: a, chain } = await app()
    chain.append('system', 'note', { text: 'old one' })
    chain.append('system', 'note', { text: 'old two' })
    await a.listen({ port: 0, host: '127.0.0.1' })
    const port = (a.server.address() as { port: number }).port

    const seqs = await new Promise<number[]>((resolve, reject) => {
      const got: number[] = []
      const req = request({ host: '127.0.0.1', port, path: '/api/stream?after=1' }, (res) => {
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          buf += chunk
          for (const m of buf.matchAll(/^id: (\d+)$/gm)) {
            const n = Number(m[1])
            if (!got.includes(n)) got.push(n)
          }
          if (got.length === 1 && got[0] === 2) chain.append('comms', 'note', { text: 'live one' })
          if (got.length >= 2) {
            req.destroy()
            resolve(got)
          }
        })
      })
      req.on('error', (err) => (got.length >= 2 ? undefined : reject(err)))
      req.end()
    })
    expect(seqs).toEqual([2, 3])
  })

  it('sends a long history whole', async () => {
    const { app: a, chain } = await app()
    const big = 'x'.repeat(400_000)
    for (let i = 0; i < 30; i++) chain.append('system', 'note', { text: `${i} ${big}` })
    await a.listen({ port: 0, host: '127.0.0.1' })
    const port = (a.server.address() as { port: number }).port

    // a slow reader: pauses between chunks, so the server has to wait for it
    const last = await new Promise<number>((resolve, reject) => {
      let seen = 0
      const req = request({ host: '127.0.0.1', port, path: '/api/stream?after=0' }, (res) => {
        let tail = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          const text = tail + chunk
          for (const m of text.matchAll(/^id: (\d+)$/gm)) seen = Math.max(seen, Number(m[1]))
          tail = text.slice(-200)
          if (seen === 30) {
            req.destroy()
            resolve(seen)
          }
          res.pause()
          setTimeout(() => res.resume(), 2)
        })
        res.on('close', () => (seen === 30 ? undefined : reject(new Error(`stream closed after ${seen}`))))
      })
      req.on('error', (err) => (seen === 30 ? undefined : reject(err)))
      req.end()
    })
    expect(last).toBe(30)
  }, 30_000)
})
