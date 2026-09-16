import { join } from 'node:path'
import type { Fact, Finding } from '@sentinel/shared'
import type { FactStore } from '../facts/store.ts'
import { injectWrongNumber, verify } from '../facts/verifier.ts'
import { chat as llmChat, type ChatRequest, type ChatResult } from '../llm/chain.ts'
import type { LogChain } from '../log/chain.ts'
import { renderPdf, sitrepHtml } from '../pdf/render.ts'

export type Chat = (req: ChatRequest) => Promise<ChatResult>

export interface SitrepDeps {
  chain: LogChain
  facts: FactStore
  runId: string
  chat?: Chat
  injectFault?: string
}

export interface Sitrep {
  text: string
  template: boolean
  factIds: string[]
}

const MAX_DRAFTS = 3

// Sections follow the HICS incident briefing a hospital commander already knows.
const SECTIONS: { title: string; prefixes: string[] }[] = [
  { title: 'Incident', prefixes: ['event.'] },
  { title: 'Situation', prefixes: ['exposure.', 'shaking.'] },
  { title: 'Expected casualties', prefixes: ['casualty.'] },
  { title: 'Hospital surge', prefixes: ['surge.', 'hospital.'] },
  { title: 'Community: power-dependent residents', prefixes: ['zip.', 'lifeline.', 'shelter.'] },
  { title: 'Access', prefixes: ['route.'] },
]

const SYSTEM = `You write the situation report for a hospital incident commander during a DRILL, structured like the HICS incident briefing form. Never write form numbers.

Hard rules:
- Every number must be written as its fact id in braces, e.g. {F12}. Never type digits or number words yourself — not for counts, times, percentages, dates, or ZIP codes. If you need a number that has no fact, leave it out.
- Use only the facts provided. Do not invent hospitals, places, counts or sources.
- Casualty figures are screening estimates with a range; say so.
- No medical or triage advice. Recommended actions are about capacity, staffing, supplies, diversion and notification.
- Markdown only. Start with the line "DRILL — Sentinel ER situation report". Then these sections as "## " headings, in order: Incident, Situation, Expected casualties, Hospital surge, Community, Recommended actions, Sources and confidence. Keep it to one page.`

function sheet(facts: Fact[]): string {
  return facts.map((f) => `${f.id} | ${f.key} | ${f.label} | ${f.display} | source: ${f.source.name}`).join('\n')
}

function explain(findings: Finding[]): string {
  return findings
    .map((f) =>
      f.kind === 'unknown_fact'
        ? `- "${f.text}" is not a fact id on the sheet.`
        : `- "${f.text}" is a number typed directly${
            f.fact_id ? `; the sheet says ${f.expected} ({${f.fact_id}}), cite that instead` : '; remove it or cite a fact'
          }.`,
    )
    .join('\n')
}

// The fallback: dull, complete, and it can't contain an unchecked number.
export function templateSitrep(facts: Fact[]): string {
  const lines = ['DRILL — Sentinel ER situation report', '']
  for (const s of SECTIONS) {
    const picked = facts.filter((f) => s.prefixes.some((p) => f.key.startsWith(p)))
    if (!picked.length) continue
    lines.push(`## ${s.title}`, ...picked.map((f) => `- ${f.label}: {${f.id}}`), '')
  }
  lines.push(
    '## Recommended actions',
    '- Review the hospital surge figures above and pre-arrange diversion for hospitals expected to fill first.',
    '- Confirm staffing and supplies for the expected arrivals.',
    '- Notify county health and equipment suppliers about power-dependent residents in affected areas.',
    '',
    '## Sources and confidence',
    '- Casualty figures are screening estimates from a trained model and carry a range.',
    '- Every figure links to its source on the console.',
  )
  return lines.join('\n')
}

export async function writeSitrep(d: SitrepDeps): Promise<Sitrep> {
  const { chain, facts, runId } = d
  const chat = d.chat ?? llmChat
  const current = facts.latest(runId)
  const all = facts.all(runId)
  chain.append('analyst', 'status', { text: `Writing the situation report from ${current.length} verified facts` }, runId)

  let feedback = ''
  for (let attempt = 1; attempt <= MAX_DRAFTS; attempt++) {
    let text: string
    try {
      const res = await chat({
        lane: 'text',
        temperature: 0.2,
        maxTokens: 1400,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: `Facts (id | key | label | value | source):\n${sheet(current)}${
              feedback ? `\n\nYour last draft was blocked by the verifier:\n${feedback}\nFix only those problems.` : ''
            }`,
          },
        ],
      })
      text = res.text.trim()
    } catch (err) {
      chain.append('analyst', 'status', { text: `Model unavailable (${(err as Error).message}); using the template`, state: 'blocked' }, runId)
      break
    }

    if (attempt === 1 && d.injectFault === 'bed_count') {
      const beds = current.find((f) => f.key.endsWith('.beds') && typeof f.value === 'number')
      if (beds) {
        const hurt = injectWrongNumber(text, beds)
        text = hurt.text
        chain.append('system', 'fault.injected', { fault: 'bed_count', detail: `${beds.label} replaced with ${hurt.wrong}` }, runId)
      }
    }

    chain.append('analyst', 'sitrep.draft', { attempt, text }, runId)
    const v = verify(text, all, 'sitrep')
    if (v.verdict !== 'block') {
      chain.append('verifier', 'verify.pass', { channel: 'sitrep', target: `sitrep draft ${attempt}`, findings: v.findings }, runId)
      return finish(d, v.rendered, false, v.factIds)
    }
    chain.append('verifier', 'verify.block', { channel: 'sitrep', target: `sitrep draft ${attempt}`, text, findings: v.findings }, runId)
    chain.append('analyst', 'status', { text: `Draft ${attempt} blocked by the verifier, redrafting`, state: 'working' }, runId)
    feedback = explain(v.findings)
  }

  const fallback = verify(templateSitrep(current), all, 'sitrep')
  chain.append('verifier', 'verify.pass', { channel: 'sitrep', target: 'template sitrep', findings: fallback.findings }, runId)
  return finish(d, fallback.rendered, true, fallback.factIds)
}

export async function publishSitrepPdf(d: SitrepDeps, sitrep: Sitrep, title: string, artifactsDir: string) {
  try {
    const html = sitrepHtml({
      text: sitrep.text,
      title,
      generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      facts: d.facts.latest(d.runId).filter((f) => sitrep.factIds.includes(f.id)),
      template: sitrep.template,
    })
    const out = await renderPdf(html, join(artifactsDir, d.runId), 'sitrep.pdf')
    d.chain.append(
      'analyst',
      'artifact',
      { type: 'sitrep_pdf', name: 'sitrep.pdf', url: `/api/runs/${d.runId}/sitrep.pdf`, bytes: out.bytes },
      d.runId,
    )
  } catch (err) {
    d.chain.append('analyst', 'error', { where: 'sitrep PDF', message: (err as Error).message }, d.runId)
  }
}

function finish(d: SitrepDeps, text: string, template: boolean, factIds: string[]): Sitrep {
  d.chain.append('analyst', 'sitrep.final', { text, template, fact_ids: factIds }, d.runId)
  d.chain.append('analyst', 'ledger', { milestone: 'sitrep_written' }, d.runId)
  d.chain.append('verifier', 'ledger', { milestone: 'verified' }, d.runId)
  d.chain.append('analyst', 'status', { text: template ? 'Sitrep ready (template)' : 'Sitrep ready and verified', state: 'done' }, d.runId)
  return { text, template, factIds }
}
