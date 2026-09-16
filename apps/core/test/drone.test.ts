import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runDroneStage } from '../src/crew/logistics.ts'
import { DEFAULT_SURVEY, lineSpacingM, planSurvey, toQgcPlan } from '../src/logistics/drone-plan.ts'
import { makeDeps } from './helpers.ts'

describe('survey planner', () => {
  it('spaces lines from the footprint', () => {
    // 2 × 120 m × tan 35° × 0.7
    expect(lineSpacingM()).toBeCloseTo(117.6, 0)
  })

  it('keeps every sortie flyable', () => {
    const s = planSurvey([38.7925, -77.115], 1.5)
    const budget = DEFAULT_SURVEY.speedMs * DEFAULT_SURVEY.enduranceMin * 60 * (1 - DEFAULT_SURVEY.reserve)
    const m = (a: [number, number], b: [number, number]) =>
      Math.hypot((a[0] - b[0]) * 111_320, (a[1] - b[1]) * 111_320 * Math.cos((a[0] * Math.PI) / 180))
    expect(s.sorties.length).toBeGreaterThan(1)
    for (const sortie of s.sorties) {
      let d = m(s.home, sortie[0]!)
      for (let i = 1; i < sortie.length; i++) d += m(sortie[i - 1]!, sortie[i]!)
      d += m(sortie.at(-1)!, s.home)
      expect(d).toBeLessThanOrEqual(budget * 1.01)
    }
  })

  it('writes a valid plan shape', () => {
    const plan = toQgcPlan([38.78, -77.13], [[38.78, -77.1], [38.781, -77.1]])
    expect(plan).toMatchObject({ fileType: 'Plan', groundStation: 'QGroundControl', version: 1 })
    const cmds = plan.mission.items.map((i) => i.command)
    expect(cmds[0]).toBe(22)
    expect(cmds.at(-1)).toBe(20)
    expect(plan.mission.items.map((i) => i.doJumpId)).toEqual([1, 2, 3, 4])
  })
})

describe('drone stage', () => {
  it('saves the plan and logs it', async () => {
    const d = makeDeps()
    const dir = mkdtempSync(join(tmpdir(), 'plan-'))
    await runDroneStage(d, 'r1', { lon: -77.115, lat: 38.7925 }, dir)
    const plan = JSON.parse(readFileSync(join(dir, 'r1', 'drone.plan'), 'utf8'))
    expect(plan.mission.items.length).toBeGreaterThan(3)
    const kinds = d.chain.after(0, 100).map((e) => e.kind)
    expect(kinds).toEqual(expect.arrayContaining(['layer', 'artifact', 'fact']))
    expect(d.facts.latest('r1').every((f) => !/\d/.test(f.label))).toBe(true)
  })
})
