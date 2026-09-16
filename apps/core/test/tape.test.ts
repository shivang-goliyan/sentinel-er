import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { TapeMiss, redact, setTapeDefaults, tapedFetch } from '../src/tape.ts'

let server: Server
let base = ''
let tapeDir = ''
let status = 200
let hits = 0
const fallbacks: string[] = []

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ hits }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(() => server.close())

beforeEach(() => {
  status = 200
  fallbacks.length = 0
  tapeDir = mkdtempSync(join(tmpdir(), 'tapes-'))
  setTapeDefaults({
    dir: tapeDir,
    defaultMode: 'live-with-fallback',
    onFallback: (source, _url, reason) => fallbacks.push(`${source}:${reason}`),
  })
})

describe('tapedFetch', () => {
  it('records then serves fallback', async () => {
    const first = await tapedFetch('usgs', `${base}/feed`)
    expect(first.fromTape).toBe(false)
    status = 503
    const second = await tapedFetch('usgs', `${base}/feed`)
    expect(second.fromTape).toBe(true)
    expect(second.json()).toEqual(first.json())
    expect(fallbacks).toEqual(['usgs:HTTP 503'])
  })

  it('passes through client errors', async () => {
    await tapedFetch('usgs', `${base}/thing`)
    status = 404
    const res = await tapedFetch('usgs', `${base}/thing`)
    expect(res.status).toBe(404)
    expect(fallbacks).toHaveLength(0)
  })

  it('replay mode never goes live', async () => {
    await expect(tapedFetch('usgs', `${base}/never`, { tape: 'replay' })).rejects.toBeInstanceOf(TapeMiss)
  })

  it('falls back when unreachable', async () => {
    const flaky = createServer((_req, res) => res.end('{"from":"flaky"}'))
    await new Promise<void>((r) => flaky.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(flaky.address() as { port: number }).port}/list`
    await tapedFetch('gdacs', url)
    await new Promise<void>((r) => flaky.close(() => r()))
    const res = await tapedFetch('gdacs', url, { timeoutMs: 1000 })
    expect(res.fromTape).toBe(true)
    expect(res.json()).toEqual({ from: 'flaky' })
    expect(fallbacks[0]).toMatch(/^gdacs:/)
  })
})

describe('redact', () => {
  it('hides keys in paths', () => {
    process.env.FIRMS_MAP_KEY = 'abcdef1234567890'
    expect(redact('https://firms/api/area/csv/abcdef1234567890/VIIRS/world/1')).toBe(
      'https://firms/api/area/csv/***/VIIRS/world/1',
    )
    delete process.env.FIRMS_MAP_KEY
  })

  it('hides key query params', () => {
    expect(redact('https://x.test/a?api_key=zzz&q=1')).toBe('https://x.test/a?api_key=***&q=1')
  })

  it('keeps secrets out of tapes', async () => {
    process.env.ORS_API_KEY = 'secret-value-123456'
    await tapedFetch('ors', `${base}/route?token=secret-value-123456`)
    delete process.env.ORS_API_KEY
    const files = readdirSync(join(tapeDir, 'ors'))
    expect(files).toHaveLength(1)
    const saved = readFileSync(join(tapeDir, 'ors', files[0]!), 'utf8')
    expect(saved).not.toContain('secret-value-123456')
  })
})
