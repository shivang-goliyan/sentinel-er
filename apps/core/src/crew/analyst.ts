import { join } from 'node:path'
import type { Fact, Finding } from '@sentinel/shared'
import type { FactStore } from '../facts/store.ts'
import { injectWrongNumber, verify } from '../facts/verifier.ts'
import { chat as llmChat, type ChatRequest, type ChatResult } from '../llm/chain.ts'
import type { LogChain } from '../log/chain.ts'
import { renderPdf, sitrepHtml } from '../pdf/render.ts'

export type Chat = (req: ChatRequest) => Promise<ChatResult>

// what the report must say about itself at the top
export type Setting = 'drill' | 'rerun' | 'live'

export const HEADING: Record<Setting, string> = {
  drill: 'DRILL — Sentinel ER situation report',
  rerun: 'RERUN OF A PAST EVENT — Sentinel ER situation report',
  live: 'Sentinel ER situation report',
}

const OCCASION: Record<Setting, string> = {
  drill: 'during a DRILL',
  rerun: 'for a rerun of a past earthquake, an exercise run with what was known at the time',
  live: 'for a live event, as decision support that a person reviews before acting',
}

export interface SitrepDeps {
  chain: LogChain
  facts: FactStore
  runId: string
  chat?: Chat
  injectFault?: string
  setting?: Setting
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

const system = (setting: Setting) => `You write the situation report for a hospital incident commander ${OCCASION[setting]}, structured like the HICS incident briefing form. Never write form numbers.

Hard rules:
- Every number must be written as its fact id in braces, e.g. {F12}. Never type digits or number words yourself — not for counts, times, percentages, dates, or ZIP codes. If you need a number that has no fact, leave it out.
- Values on the sheet already include their units ("24 km", "41%"). Don't repeat the unit after the id, and don't state the same fact twice in one sentence.
- Name sources only by their id in braces, e.g. {S3}; the source list gives the names. Never type a source's name or version yourself. List each id you used under Sources and confidence.
- A time window that is part of a fact's label, like "within three hours" or "day two", may be written in words exactly as the label says it. Never put a fact id where a window belongs.
- If a section has no facts, say so in one line.
- Keep it short: name only the few hospitals that fill first and the few ZIP areas with the most residents at risk; the console has the rest.
- Use only the facts provided. Do not invent hospitals, places, counts or sources.
- Casualty figures are screening estimates with a range; say so.
- No medical or triage advice. Recommended actions are about capacity, staffing, supplies, diversion and notification.
- Markdown only. Start with the line "${HEADING[setting]}". Then these sections as "## " headings, in order: Incident, Situation, Expected casualties, Hospital surge, Community, Recommended actions, Sources and confidence. Keep it to one page.`

// A draft that stops mid-sentence can still pass the number check. These sections come first and
// last, so a cut-off draft is missing at least the final one.
const REQUIRED = ['Incident', 'Recommended actions', 'Sources and confidence']

export function missingSections(text: string): string[] {
  const heads = [...text.matchAll(/^#{2,3}\s+(.+?)\s*$/gm)].map((m) => m[1]!.toLowerCase())
  const missing = REQUIRED.filter((r) => !heads.some((h) => h.startsWith(r.toLowerCase())))
  if (missing.length) return missing
  // and the last section has to have something under it that ends like a sentence or a list item
  const tail = text.slice(text.search(/^#{2,3}\s+sources and confidence/im)).split('\n').slice(1).map((l) => l.trim()).filter(Boolean)
  const last = tail.at(-1) ?? ''
  if (/[.!?)\]}"'%]$/.test(last)) return []
  // bullets often skip the full stop; one ending on "that" or "the" was cut off
  const bullet = /^[-*]\s+\S+(\s+\S+){2,}$/.test(last)
  const dangling = /\b(a|an|the|of|to|and|or|but|with|for|in|on|at|by|from|that|which|is|are|was|were|be|as|than|about)$/i.test(last)
  return bullet && !dangling ? [] : ['Sources and confidence (it stops early)']
}

// Source names carry digits ("Census 2020", "HAZUS 6.1"), so the model refers to them by id and
// the names go in after the number check.
function sourceIds(facts: Fact[]): Map<string, string> {
  const ids = new Map<string, string>()
  for (const f of facts) if (!ids.has(f.source.name)) ids.set(f.source.name, `S${ids.size + 1}`)
  return ids
}

function sheet(facts: Fact[], sources: Map<string, string>): string {
  const rows = facts.map((f) => `${f.id} | ${f.key} | ${f.label} | ${f.display} | ${sources.get(f.source.name)}`)
  const list = [...sources].map(([name, id]) => `${id} | ${name}`)
  return `Facts (id | key | label | value | source id):\n${rows.join('\n')}\n\nSources (id | name):\n${list.join('\n')}`
}

const SOURCE_REF = /\{(S\d+)\}/g

// a source name typed out in full is fine; turn it into its id so its digits aren't read as claims.
// Same for "[3]" references and "1." list markers, which count nothing.
function sourcesToIds(text: string, sources: Map<string, string>): string {
  const known = new Set(sources.values())
  let out = text
    .replace(/^(\s*)\d+[.)]\s+/gm, '$1- ')
    .replace(/\[(\d+)\]/g, (whole, n: string) => (known.has(`S${n}`) ? `{S${n}}` : whole))
  for (const [name, id] of [...sources].sort((a, b) => b[0].length - a[0].length)) out = out.split(name).join(`{${id}}`)
  // "{S3}: {S3}", "{S3} ({S3})" and the like, on one line, say it once
  return out.replace(/\{(S\d+)\}(?:[ \t]*[:(–—-]?[ \t]*\{\1\}\)?)+/g, '{$1}')
}

// In the body a source is a short "[3]"; under Sources and confidence it is "[3] its name", one per line.
function nameSources(text: string, sources: Map<string, string>): string {
  const byId = new Map([...sources].map(([name, id]) => [id, name]))
  const at = text.search(/^#{2,3}\s+sources and confidence/im)
  const body = at === -1 ? text : text.slice(0, at)
  const tail = at === -1 ? '' : text.slice(at)
  const short = (s: string) => s.replace(SOURCE_REF, (whole, id: string) => (byId.has(id) ? `[${id.slice(1)}]` : whole))
  const lines = tail.split('\n').flatMap((line) => {
    const refs = [...line.matchAll(SOURCE_REF)].map((m) => m[1]!).filter((id) => byId.has(id))
    // a bare run of ids becomes a list
    if (refs.length > 1 && !line.replace(SOURCE_REF, '').replace(/[\s,;*-]|and/g, '')) return refs.map((id) => `- [${id.slice(1)}] ${byId.get(id)}`)
    return [line.replace(SOURCE_REF, (whole, id: string) => (byId.has(id) ? `[${id.slice(1)}] ${byId.get(id)}` : whole))]
  })
  return short(body) + lines.join('\n')
}

const unknownSources = (text: string, sources: Map<string, string>) => {
  const known = new Set(sources.values())
  return [...text.matchAll(SOURCE_REF)].map((m) => m[0]).filter((ref) => !known.has(ref.slice(1, -1)))
}

function explain(findings: Finding[]): string {
  return findings
    .map((f) =>
      f.kind === 'unknown_fact'
        ? `- "${f.text}" is not a fact id on the sheet.`
        : `- "${f.text}" is a number typed directly. If it names a time window, word it exactly as the fact's label does. Otherwise cite the fact that holds it${
            f.fact_id ? ` (perhaps {${f.fact_id}})` : ''
          }, drop it, or if it belongs to a source's name write that source's id instead.`,
    )
    .join('\n')
}

// The fallback: dull, complete, and it can't contain an unchecked number.
const TEMPLATE_ZIPS = 3
const TEMPLATE_HOSPITALS = 5

export function templateSitrep(facts: Fact[], setting: Setting = 'drill', sources = sourceIds(facts)): string {
  const lines = [HEADING[setting], '']
  // the worst few ZIPs are enough on paper; the console has the rest
  const zips = [...new Set(facts.filter((f) => f.key.startsWith('zip.')).map((f) => f.key.split('.')[1]))].slice(0, TEMPLATE_ZIPS)
  // surge rows come in fill order; the hospitals that fill first are the ones worth a line
  // (without a surge, the nearest few; hospital facts arrive nearest first)
  const idsOf = (re: RegExp) => [...new Set(facts.filter((f) => re.test(f.key)).map((f) => f.key.split('.')[1]))].slice(0, TEMPLATE_HOSPITALS)
  const surged = idsOf(/^surge\.[^.]+\.share$/)
  const firstIn = surged.length ? surged : idsOf(/^hospital\./)
  const keep = (f: Fact) => {
    const [head, id] = f.key.split('.')
    if (head === 'exposure' && f.value === 0) return false
    if (head === 'zip') return zips.includes(id!)
    if (head === 'hospital') return firstIn.includes(id!) && !f.key.endsWith('.phone')
    if (head === 'surge' && id !== 'first') return firstIn.includes(id!)
    return true
  }
  for (const s of SECTIONS) {
    const picked = facts.filter((f) => s.prefixes.some((p) => f.key.startsWith(p)) && keep(f))
    if (!picked.length) continue
    lines.push(`## ${s.title}`, ...picked.map((f) => `- ${f.label}: {${f.id}}`), '')
  }
  const has = (prefix: string) => facts.some((f) => f.key.startsWith(prefix))
  lines.push('## Recommended actions')
  if (has('surge.')) lines.push('- Pre-arrange diversion for the hospitals expected to fill first, and confirm staffing and supplies for the expected arrivals.')
  else lines.push('- No hospital with a known bed count is in range; confirm capacity with the nearest receiving hospitals directly.')
  if (has('zip.')) lines.push('- Notify county health and home medical equipment suppliers about power-dependent residents in the ZIP areas above.')
  lines.push(
    '',
    '## Sources and confidence',
    '- Casualty figures are screening estimates from a trained model and carry a range.',
    ...[...sources.values()].map((id) => `- {${id}}`),
  )
  return lines.join('\n')
}

export async function writeSitrep(d: SitrepDeps): Promise<Sitrep> {
  const { chain, facts, runId } = d
  const setting = d.setting ?? 'drill'
  const chat = d.chat ?? llmChat
  const current = facts.latest(runId)
  const all = facts.all(runId)
  const sources = sourceIds(current)
  chain.append('analyst', 'status', { text: `Writing the situation report from ${current.length} verified facts` }, runId)

  let feedback = ''
  let lastDraft = ''
  for (let attempt = 1; attempt <= MAX_DRAFTS; attempt++) {
    let text: string
    try {
      const res = await chat({
        lane: 'text',
        temperature: 0.2,
        // thinking models spend from the same budget before writing a word
        maxTokens: 4000,
        messages: [
          { role: 'system', content: system(setting) },
          { role: 'user', content: sheet(current, sources) },
          // a redraft sees its own draft, so it fixes the problems instead of starting over
          ...(feedback && lastDraft
            ? [
                { role: 'assistant' as const, content: lastDraft },
                { role: 'user' as const, content: `That draft was sent back:\n${feedback}\nReturn the whole report again with only those problems fixed.` },
              ]
            : []),
        ],
      })
      text = res.text.trim()
      if (!text) {
        chain.append('analyst', 'status', { text: `Draft ${attempt} came back empty, asking again`, state: 'working' }, runId)
        continue
      }
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
    // whatever the model wrote on top, the heading is ours
    text = sourcesToIds(`${HEADING[setting]}\n\n${text.replace(/^\s*(?:#+\s*)?[^\n]*situation report[^\n]*\n+/i, '')}`, sources)
    lastDraft = text
    const v = verify(text, all, 'sitrep')
    if (v.verdict !== 'block') {
      // the numbers are fine; now make sure it's a whole report
      const missing = missingSections(text)
      const badRefs = unknownSources(text, sources)
      if (badRefs.length) missing.push(`real source ids (${badRefs.join(', ')} are not on the list)`)
      if (!missing.length) {
        chain.append('verifier', 'verify.pass', { channel: 'sitrep', target: `sitrep draft ${attempt}`, findings: v.findings }, runId)
        return finish(d, nameSources(v.rendered, sources), false, v.factIds)
      }
      chain.append('analyst', 'status', { text: `Draft ${attempt} is incomplete (missing ${missing.join(', ')}), redrafting`, state: 'working' }, runId)
      feedback = `- The draft stopped early or skipped sections. Missing: ${missing.join(', ')}. Write the whole report, every section.`
      continue
    }
    chain.append('verifier', 'verify.block', { channel: 'sitrep', target: `sitrep draft ${attempt}`, text, findings: v.findings }, runId)
    chain.append('analyst', 'status', { text: `Draft ${attempt} blocked by the verifier, redrafting`, state: 'working' }, runId)
    feedback = explain(v.findings)
  }

  const fallback = verify(templateSitrep(current, setting, sources), all, 'sitrep')
  chain.append('verifier', 'verify.pass', { channel: 'sitrep', target: 'template sitrep', findings: fallback.findings }, runId)
  return finish(d, nameSources(fallback.rendered, sources), true, fallback.factIds)
}

export async function publishSitrepPdf(d: SitrepDeps, sitrep: Sitrep, title: string, artifactsDir: string) {
  try {
    const html = sitrepHtml({
      text: sitrep.text,
      title,
      generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      facts: d.facts.latest(d.runId).filter((f) => sitrep.factIds.includes(f.id)),
      template: sitrep.template,
      setting: d.setting ?? 'drill',
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
