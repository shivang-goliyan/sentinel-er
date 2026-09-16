import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { LogEntry } from '@sentinel/shared'
import { setTapeDefaults } from '../src/tape.ts'
import { PASS, makeApp } from './helpers.ts'

// no network in tests: every outside call replays from an empty tape folder and fails fast,
// which also exercises the fallbacks (emPOWER snapshot, missing OpenStreetMap)
const saved = { ...process.env }
beforeAll(() => {
  process.env.TAPE_MODE_OVERPASS = 'replay'
  process.env.TAPE_MODE_EMPOWER = 'replay'
  setTapeDefaults({ dir: mkdtempSync(join(tmpdir(), 'drill-tapes-')), defaultMode: 'replay' })
})
afterAll(() => {
  process.env = saved
})

type App = Awaited<ReturnType<typeof makeApp>>
let current: App | null = null
afterEach(async () => {
  await current?.app.close()
  current = null
})

function waitFor(app: App, pred: (e: LogEntry) => boolean, ms = 15_000): Promise<LogEntry> {
  return new Promise((resolve, reject) => {
    const hit = app.chain.after(0, 5000).find(pred)
    if (hit) return resolve(hit)
    const timer = setTimeout(() => {
      off()
      reject(new Error('timed out waiting for the log'))
    }, ms)
    const off = app.bus.on((e) => {
      if (!pred(e)) return
      clearTimeout(timer)
      off()
      resolve(e)
    })
  })
}

describe('drill route', () => {
  it('needs the operator passcode', async () => {
    current = await makeApp()
    const res = await current.app.inject({ method: 'POST', url: '/api/drill', payload: {} })
    expect(res.statusCode).toBe(401)
  })

  it('rejects unknown fields', async () => {
    current = await makeApp()
    const res = await current.app.inject({
      method: 'POST',
      url: '/api/drill',
      headers: { 'x-operator': PASS },
      payload: { mag: 6.4, city: 'Alexandria' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('builds context for the drill', async () => {
    current = await makeApp()
    const app = current
    const res = await app.app.inject({ method: 'POST', url: '/api/drill', headers: { 'x-operator': PASS }, payload: {} })
    expect(res.statusCode).toBe(202)
    const { run_id } = res.json() as { run_id: string }

    await waitFor(app, (e) => e.kind === 'ledger' && e.payload.milestone === 'context_built' && e.run_id === run_id)
    const entries = app.chain.after(0, 5000).filter((e) => e.run_id === run_id)
    const detected = entries.find((e) => e.kind === 'event.detected')
    expect(detected?.kind === 'event.detected' && detected.payload.event.is_drill).toBe(true)
    expect(entries.find((e) => e.kind === 'event.tiered')).toMatchObject({ payload: { tier: 2 } })
    expect(entries.filter((e) => e.kind === 'layer').map((e) => e.kind === 'layer' && e.payload.name)).toEqual(
      expect.arrayContaining(['shaking', 'hospitals', 'zips']),
    )

    const facts = app.facts.latest(run_id)
    for (const f of facts) expect(f.label).not.toMatch(/\d/)
    expect(app.facts.byKey(run_id, 'event.magnitude')?.display).toBe('M6.4')
    expect(app.facts.byKey(run_id, 'exposure.pop_damaging')?.value).toBeGreaterThan(1_000_000)
    expect(app.facts.byPrefix(run_id, 'hospital.').length).toBeGreaterThan(20)
    // emPOWER came from the committed snapshot, and said so
    const oldTown = app.facts.byKey(run_id, 'zip.22314.power_dependent')
    expect(oldTown?.source.name).toContain('snapshot')
    expect(entries.some((e) => e.kind === 'fallback.used')).toBe(true)
    const masked = app.facts.byPrefix(run_id, 'zip.').find((f) => f.value === 11)
    if (masked) expect(masked.display).toBe('≤11')
    // OpenStreetMap had nothing to replay; the stage carried on and said why
    expect(entries.some((e) => e.kind === 'status' && e.actor === 'scout' && e.payload.state === 'error')).toBe(true)
  })

  it('replaces the running drill', async () => {
    current = await makeApp()
    const post = () =>
      current!.app.inject({ method: 'POST', url: '/api/drill', headers: { 'x-operator': PASS }, payload: { mag: 5.5 } })
    const first = (await post()).json() as { run_id: string }
    const second = (await post()).json() as { run_id: string }
    expect(second.run_id).not.toBe(first.run_id)
    const ended = current.chain.after(0, 5000).find((e) => e.kind === 'run.ended' && e.run_id === first.run_id)
    expect(ended).toBeDefined()
    await waitFor(current, (e) => e.kind === 'ledger' && e.payload.milestone === 'context_built' && e.run_id === second.run_id)
  })
})
