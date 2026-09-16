import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CasualtyOut } from '../src/crew/casualty.ts'
import { exposureInput, grade, loadScenario, recordGrade } from '../src/modes/rerun.ts'
import { PASS, makeApp, makeDeps } from './helpers.ts'

const band = (p10: number, p50: number, p90: number) => ({ p10, p50, p90 })

const casualty = (deaths: ReturnType<typeof band>, injured: ReturnType<typeof band>): CasualtyOut => ({
  deaths,
  injured,
  explain: { prior_log1p: 0, contributions: [] },
  country: { iso3: 'TUR', name: 'Türkiye', region: 'x' },
  prior_deaths: 0,
  model: { variant: 'test', trained_rows: null },
})

// first estimate has the shallower-looking shaking; the final one is worse
let science: Server
let url = ''
beforeAll(async () => {
  science = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const input = JSON.parse(body) as { pop_mmi: Record<string, number> }
      const final = (input.pop_mmi['9'] ?? 0) > 0
      const out = final
        ? casualty(band(88, 4073, 52112), band(6414, 45693, 181544))
        : casualty(band(10, 354, 4504), band(531, 1849, 22004))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(out))
    })
  })
  await new Promise<void>((r) => science.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(science.address() as AddressInfo).port}`
})
afterAll(() => science.close())

const until = async (check: () => boolean, ms = 3000) => {
  const t = Date.now()
  while (!check()) {
    if (Date.now() - t > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('grading', () => {
  it('scores inside and outside', () => {
    expect(grade(band(10, 354, 4504), 4504, 56697)).toMatchObject({ inside: false, planning_log10_error: 1.1 })
    expect(grade(band(33, 986, 16577), 16577, 8957).inside).toBe(true)
    expect(grade(band(0, 0, 1), 1, null).inside).toBeNull()
  })

  it('words a zero toll plainly', () => {
    const d = makeDeps()
    const truth = loadScenario('mineral-va-2011').truth
    recordGrade(d, 'run-va', truth, casualty(band(0, 0, 1), band(2, 11, 36)), 'p90')
    const said = d.chain.after(0).filter((e) => e.kind === 'status').map((e) => (e.payload as { text: string }).text)
    expect(said).toContain('Graded deaths: none recorded, inside our range of 0 to 1')
    expect(d.facts.latest('run-va').find((f) => f.key === 'truth.injured')).toBeUndefined()
  })

  it('reads early exposure bands', () => {
    const input = exposureInput(loadScenario('turkey-2023').pager)
    expect(input.popMmi[8]).toBe(304968)
    expect(input.popMmi[9]).toBe(0)
    expect(input.iso3).toBe('TUR')
    expect(Math.floor(input.localHour!)).toBe(4)
  })
})

describe('rerun route', () => {
  it('lists the scenarios', async () => {
    const { app } = await makeApp()
    const res = await app.inject('/api/rerun/scenarios')
    const list = res.json() as { name: string; first_estimate_minutes: number | null }[]
    expect(list.map((s) => s.name)).toEqual(['turkey-2023', 'nepal-2015', 'mineral-va-2011'])
    expect(list[0]!.first_estimate_minutes).toBe(21)
    await app.close()
  })

  it('needs the operator', async () => {
    const { app } = await makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/rerun', payload: { scenario: 'turkey-2023' } })
    expect(res.statusCode).toBe(401)
    await app.close()
  })

  it('grades Türkiye both ways', async () => {
    const a = await makeApp({ SCIENCE_URL: url })
    const res = await a.app.inject({ method: 'POST', url: '/api/rerun', headers: { 'x-operator': PASS }, payload: { scenario: 'turkey-2023' } })
    expect(res.statusCode).toBe(202)
    const { run_id: runId } = res.json() as { run_id: string }
    await until(() => a.chain.after(0, 5000).some((e) => e.run_id === runId && e.kind === 'run.ended'))

    const facts = Object.fromEntries(a.facts.latest(runId).map((f) => [f.key, f.value]))
    expect(facts['casualty.deaths.p90']).toBe(4504)
    expect(facts['truth.deaths']).toBe(56697)
    expect(facts['grade.deaths.inside']).toBe('no')
    expect(facts['hindsight.deaths.p90']).toBe(52112)
    expect(facts['grade.hindsight.injured.inside']).toBe('yes')

    const said = a.chain
      .after(0, 5000)
      .filter((e) => e.run_id === runId && e.kind === 'status')
      .map((e) => (e.payload as { text: string }).text)
    expect(said).toContain('Graded deaths: 56,697 recorded, above our range of 10 to 4,504; the planning figure of 4,504 was about 13 times lower')
    expect(said.some((t) => t.startsWith("With USGS's final shaking estimate: 56,697 recorded, above our range of 88 to 52,112"))).toBe(true)
    expect(a.chain.verify().ok).toBe(true)
    await a.app.close()
  })

  it('rejects unknown scenarios', async () => {
    const { app } = await makeApp()
    const res = await app.inject({ method: 'POST', url: '/api/rerun', headers: { 'x-operator': PASS }, payload: { scenario: 'atlantis' } })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})
