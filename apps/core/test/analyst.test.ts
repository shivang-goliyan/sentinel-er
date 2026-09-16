import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { missingSections, publishSitrepPdf, templateSitrep, writeSitrep, type Chat } from '../src/crew/analyst.ts'
import { markdownToHtml, sitrepHtml } from '../src/pdf/render.ts'
import { verify } from '../src/facts/verifier.ts'
import { makeDeps } from './helpers.ts'

const src = { name: 'FEMA Hospitals RAPT', retrieved_at: '2026-09-16T00:00:00Z', method: 'dataset' as const }

function world() {
  const d = makeDeps()
  const run = 'run-a'
  const beds = d.facts.add(run, { key: 'hospital.inova.beds', label: 'Inova Alexandria staffed beds', value: 312, unit: 'beds', source: src })
  const injured = d.facts.add(run, {
    key: 'casualty.injured.p50',
    label: 'Expected injured, middle estimate',
    value: 240,
    unit: 'people',
    source: { name: 'Sentinel casualty model', retrieved_at: 'now', method: 'model' },
  })
  return { ...d, run, beds, injured }
}

const ENDING = '\n\n## Recommended actions\n- Staff up.\n\n## Sources and confidence\n- Screening estimates, sources on the console.'

// drafts get the closing sections unless they're meant to be cut off
const replies = (...texts: (string | Error | { raw: string })[]): Chat => {
  let i = 0
  return async () => {
    const t = texts[Math.min(i++, texts.length - 1)]!
    if (t instanceof Error) throw t
    const text = typeof t === 'string' ? (t && !t.includes('## Incident') ? `## Incident\n- A drill.\n\n${t}` : t) + (t ? ENDING : '') : t.raw
    return { text, toolCalls: [], provider: 'fake', model: 'fake', ms: 1 }
  }
}

const kinds = (w: ReturnType<typeof world>) => w.chain.after(0, 500).map((e) => e.kind)

describe('writeSitrep', () => {
  it('passes a cited draft', async () => {
    const w = world()
    const s = await writeSitrep({ ...w, runId: w.run, chat: replies(`## Hospital surge\n- Inova has {${w.beds.id}} staffed beds.`) })
    expect(s.template).toBe(false)
    expect(s.text).toContain('Inova has 312 staffed beds.')
    expect(kinds(w)).toEqual(expect.arrayContaining(['sitrep.draft', 'verify.pass', 'sitrep.final', 'ledger']))
  })

  it('redrafts after a block', async () => {
    const w = world()
    const s = await writeSitrep({
      ...w,
      runId: w.run,
      chat: replies('About 240 injured.', `About {${w.injured.id}} injured.`),
    })
    expect(s.template).toBe(false)
    expect(kinds(w).filter((k) => k === 'sitrep.draft')).toHaveLength(2)
    expect(kinds(w)).toContain('verify.block')
  })

  it('falls back to the template', async () => {
    const w = world()
    const s = await writeSitrep({ ...w, runId: w.run, chat: replies(new Error('quota gone')) })
    expect(s.template).toBe(true)
    expect(s.text).toContain('Inova Alexandria staffed beds: 312')
  })

  it('catches the staged fault', async () => {
    const w = world()
    const good = `Inova has {${w.beds.id}} staffed beds.`
    const s = await writeSitrep({ ...w, runId: w.run, chat: replies(good, good), injectFault: 'bed_count' })
    const log = w.chain.after(0, 500)
    const block = log.find((e) => e.kind === 'verify.block')!
    expect(log.some((e) => e.kind === 'fault.injected')).toBe(true)
    expect(JSON.stringify(block.payload)).toContain('"expected":"312"')
    expect(s.text).toContain('312 staffed beds')
  })

  it('never leaves ids unrendered', () => {
    const w = world()
    expect(templateSitrep(w.facts.latest(w.run))).toContain(`{${w.beds.id}}`)
  })
})

describe('sitrep heading', () => {
  it('names reruns as reruns', async () => {
    const w = world()
    const s = await writeSitrep({
      ...w,
      runId: w.run,
      setting: 'rerun',
      chat: replies(`# DRILL — Sentinel ER situation report\n\n## Incident\n- Inova has {${w.beds.id}} beds.`),
    })
    expect(s.text.split('\n')[0]).toBe('RERUN OF A PAST EVENT — Sentinel ER situation report')
    expect(s.text).not.toContain('DRILL')
  })

  it('sends back a cut-off draft', async () => {
    const w = world()
    const cut = { raw: `## Incident\n- Inova has {${w.beds.id}} beds, which indicates` }
    const whole = `## Incident\n- Inova has {${w.beds.id}} beds.${ENDING}`
    const s = await writeSitrep({ ...w, runId: w.run, chat: replies(cut, { raw: whole }) })
    expect(s.text).toContain('Staff up.')
    const said = w.chain.after(0, 500).filter((e) => e.kind === 'status').map((e) => (e.payload as { text: string }).text)
    expect(said).toContain('Draft 1 is incomplete (missing Recommended actions, Sources and confidence), redrafting')
    expect(missingSections(`${whole}\n- which indicates that`)).toEqual(['Sources and confidence (it stops early)'])
  })

  it('names sources after checking', async () => {
    const w = world()
    w.facts.add(w.run, { key: 'exposure.pop_mmi.7', label: 'People at level seven', value: 31175, unit: 'people', source: { name: 'US Census 2020 block groups', retrieved_at: 'now', method: 'dataset' } })
    const s = await writeSitrep({ ...w, runId: w.run, chat: replies(`## Situation\n- {F3} people, per {S3}.\n- Beds from {S1}.`) })
    expect(s.template).toBe(false)
    expect(s.text).toContain('31,175 people, per [3].')
    expect(s.text).toContain('Beds from [1].')
    expect(s.text).toContain('- Screening estimates, sources on the console.')
  })

  it('turns typed source names into ids', async () => {
    const w = world()
    w.facts.add(w.run, { key: 'exposure.pop_mmi.7', label: 'People at level seven', value: 31175, unit: 'people', source: { name: 'US Census 2020 block groups', retrieved_at: 'now', method: 'dataset' } })
    const text = `## Incident\n- From US Census 2020 block groups.\n\n## Recommended actions\n- Staff up.\n\n## Sources and confidence\n- {S3}: US Census 2020 block groups\n{S1}, {S2}`
    const s = await writeSitrep({ ...w, runId: w.run, chat: replies({ raw: text }) })
    expect(s.template).toBe(false)
    expect(s.text).toContain('- From [3].')
    expect(s.text).toContain('- [3] US Census 2020 block groups\n- [1] FEMA Hospitals RAPT\n- [2] Sentinel casualty model')
  })

  it('reads typed references and numbered lists', async () => {
    const w = world()
    const text = `## Incident\n1. Beds per [1].\n2) Casualties per [2].\n\n## Recommended actions\n- Staff up.\n\n## Sources and confidence\n[1] FEMA Hospitals RAPT\n- FEMA Hospitals RAPT: {S1}\n[2]`
    const s = await writeSitrep({ ...w, runId: w.run, chat: replies({ raw: text }) })
    expect(s.template).toBe(false)
    expect(s.text).toContain('- Beds per [1].\n- Casualties per [2].')
    expect(s.text).toContain('[1] FEMA Hospitals RAPT\n- [1] FEMA Hospitals RAPT\n[2] Sentinel casualty model')
  })

  it('redrafts from its own draft', async () => {
    const w = world()
    const seen: string[][] = []
    const chat: Chat = async (req) => {
      seen.push(req.messages.map((m) => m.role))
      const text = seen.length === 1 ? '## Incident\n- 312 beds.' : `## Incident\n- {${w.beds.id}} beds.`
      return { text: text + ENDING, toolCalls: [], provider: 'fake', model: 'fake', ms: 1 }
    }
    await writeSitrep({ ...w, runId: w.run, chat })
    expect(seen).toEqual([['system', 'user'], ['system', 'user', 'assistant', 'user']])
  })

  it('sends back made-up source ids', async () => {
    const w = world()
    const s = await writeSitrep({ ...w, runId: w.run, chat: replies('- Beds from {S9}.', '- Beds from {S1}.') })
    expect(s.text).toContain('Beds from [1].')
    const said = w.chain.after(0, 500).filter((e) => e.kind === 'status').map((e) => (e.payload as { text: string }).text)
    expect(said.some((t) => t.includes('{S9} are not on the list'))).toBe(true)
  })

  it('template stays short and clean', () => {
    const w = world()
    for (const z of ['22314', '22301', '22302', '22303', '22304']) {
      w.facts.add(w.run, { key: `zip.${z}.at_risk`, label: 'Power-dependent residents at risk', value: 12, unit: 'people', source: { name: 'HHS emPOWER 2026', retrieved_at: 'now', method: 'api' } })
    }
    w.facts.add(w.run, { key: 'exposure.pop_mmi.9', label: 'People at level nine', value: 0, unit: 'people', source: src })
    const t = templateSitrep(w.facts.latest(w.run))
    expect(t.match(/residents at risk/g)).toHaveLength(3)
    expect(t).not.toContain('level nine')
    const v = verify(t, w.facts.all(w.run), 'sitrep')
    expect(v.findings).toEqual([])
  })

  it('retries an empty draft', async () => {
    const w = world()
    const s = await writeSitrep({ ...w, runId: w.run, chat: replies('', `## Incident\n- Inova has {${w.beds.id}} beds.`) })
    expect(s.template).toBe(false)
    expect(s.text).toContain('Inova has 312 beds.')
  })

  it('adds the heading when missing', async () => {
    const w = world()
    const s = await writeSitrep({ ...w, runId: w.run, chat: replies(`## Incident\n- Inova has {${w.beds.id}} beds.`) })
    expect(s.text.startsWith('DRILL — Sentinel ER situation report\n\n## Incident')).toBe(true)
  })

  it('bannerless pdf for live events', () => {
    const base = { text: 'Sentinel ER situation report\n\n## Incident', title: 'M6', generatedAt: 'now', facts: [], template: false }
    expect(sitrepHtml({ ...base, setting: 'live' })).not.toContain('class="drill"')
    expect(sitrepHtml({ ...base, setting: 'rerun' })).toContain('RERUN OF A PAST EVENT')
    expect(sitrepHtml(base)).toContain('DRILL — NOT A REAL EVENT')
    expect(sitrepHtml(base)).not.toContain('<p>Sentinel ER situation report</p>')
  })
})

describe('sitrep pdf', () => {
  it('turns markdown into html', () => {
    const html = markdownToHtml('## Surge\n- **Inova** <fills> first\n\nPlain line')
    expect(html).toBe('<h2>Surge</h2>\n<ul>\n<li><strong>Inova</strong> &lt;fills&gt; first</li>\n</ul>\n<p>Plain line</p>')
  })

  const hasBrowser = existsSync(join(process.env.HOME ?? '', '.cache/ms-playwright'))
  it.skipIf(!hasBrowser)('renders a real pdf', async () => {
    const w = world()
    const s = await writeSitrep({ ...w, runId: w.run, chat: replies(`## Incident\n- Inova has {${w.beds.id}} beds.`) })
    const dir = mkdtempSync(join(tmpdir(), 'sitrep-'))
    await publishSitrepPdf({ ...w, runId: w.run }, s, 'Drill: M6.4 near Alexandria', dir)
    const pdf = readFileSync(join(dir, w.run, 'sitrep.pdf'))
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF')
    expect(kinds(w)).toContain('artifact')
  }, 30_000)
})
