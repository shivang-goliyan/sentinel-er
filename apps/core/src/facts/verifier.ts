import type { Fact, Finding, VerifyChannel } from '@sentinel/shared'
import { findNumbers, numberIn, type FoundNumber } from './numbers.ts'

export type Verdict = 'pass' | 'pass_with_note' | 'block'

export interface Verified {
  rendered: string
  verdict: Verdict
  findings: Finding[]
  factIds: string[]
}

export const SAFE_LINE = "I don't want to give you a figure I can't back up. The verified number is on the console."

const PLACEHOLDER = /\{(F[0-9a-z]+)\}/g
// a placeholder with the letters stuck to its front and the word after it, so "M{F1}" and
// "{F3} km" don't come out as "MM6.4" and "6 km km"
const PLACEHOLDER_NEXT = /((?:[A-Za-z]+\s+){0,2})([A-Za-z]{1,3})?\{(F[0-9a-z]+)\}(\s*[A-Za-z%]+)?/g

// "Up to {F9}" where the value reads "up to 10,878": say "up to" once
function dropRepeatedLead(words: string, shown: string): string {
  const parts = words.match(/[A-Za-z]+\s+/g) ?? []
  for (let k = parts.length; k > 0; k--) {
    const lead = parts.slice(-k).join('')
    if (shown.toLowerCase().startsWith(lead.toLowerCase())) return parts.slice(0, -k).join('')
  }
  return words
}

function repeatsUnit(shown: string, after: string) {
  // "6 km" ends in km, "41%" in %, "VII (7.4)" in nothing
  const unit = /(?:^|[\s\d])([a-z]+|%)$/i.exec(shown.trim())?.[1]?.toLowerCase()
  const next = after.trim().toLowerCase()
  if (!unit || !next) return false
  return next === unit || next === `${unit}s` || `${next}s` === unit
}
const ALWAYS_OK = new Set(['911'])

function close(a: number, b: number, tol: Fact['tolerance']) {
  const abs = tol.abs ?? 0
  const rel = tol.rel ?? 0
  const slack = Math.max(abs, Math.abs(b) * rel)
  return Math.abs(a - b) <= slack + 1e-9
}

// "(703) 504-3000" and "+17035043000" both become 703 / 504 / 3000
function digitGroups(display: string): string[] {
  const groups = display.match(/\d+/g) ?? []
  const national = groups.join('').replace(/^1(?=\d{10}$)/, '')
  if (national.length === 10 && groups.every((g) => g.length >= 3)) return [national.slice(0, 3), national.slice(3, 6), national.slice(6)]
  return groups
}

// Text facts hold numbers too (ZIP codes, street and phone numbers). A said number has to be one
// of their digit groups, or several in a row; "430" is not in "(703) 504-3000".
function inText(said: string, display: string): boolean {
  const digits = said.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  if (!digits) return false
  const groups = digitGroups(display)
  for (let i = 0; i < groups.length; i++) {
    let run = ''
    for (let j = i; j < groups.length && run.length < digits.length; j++) {
      run += groups[j]
      if (run === digits) return true
    }
  }
  return false
}

function matches(n: FoundNumber, f: Fact): boolean {
  if (n.value === null) return false
  if (typeof f.value === 'string') return inText(n.text, f.display)
  if (close(n.value, f.value, f.tolerance)) return true
  if (f.unit === 'probability' && close(n.value, f.value * 100, { abs: 0.5 })) return true
  const shown = numberIn(f.display)
  return shown !== null && close(n.value, shown, { abs: 0 })
}

const SMALL_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']

// "within three hours" or "day two" name which fact is meant, and the labels say them the same way
function namesAWindow(n: FoundNumber, text: string, labels: string[]): boolean {
  const prev = /([a-z]+)\W*$/i.exec(text.slice(Math.max(0, n.start - 20), n.start))?.[1]?.toLowerCase()
  const next = /^\W*([a-z]+)/i.exec(text.slice(n.end, n.end + 20))?.[1]?.toLowerCase()
  const said = n.kind === 'words' ? n.text.toLowerCase().replace(/-/g, ' ') : (n.value !== null && SMALL_WORDS[n.value]) || ''
  if (!said) return false
  if (!prev) return false
  const phrase = next ? ` ${prev} ${said} ${next} ` : null
  return labels.some((l) => (phrase !== null && l.includes(phrase)) || (prev === 'day' && l.includes(` day ${said} `)))
}

const STOP = new Set(['with', 'from', 'that', 'this', 'have', 'there', 'their', 'about', 'which', 'expected', 'estimate'])
const words = (t: string) => new Set(t.toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => !STOP.has(w)) ?? [])

// When a number matches nothing, point at the fact the sentence was probably about, so the
// block can show what the source actually says.
function likelyFact(n: FoundNumber, text: string, facts: Fact[]): Fact | undefined {
  const around = words(text.slice(Math.max(0, n.start - 60), n.end + 60))
  const ratioish = (f: Fact) => f.unit === 'percent' || f.unit === 'probability'
  let best: Fact | undefined
  let bestScore = 0
  let bestGap = Infinity
  for (const f of facts) {
    if (typeof f.value !== 'number') continue
    // "430" isn't a percentage and "41%" isn't a head count
    if ((n.kind === 'percent') !== ratioish(f)) continue
    let score = 0
    for (const w of words(`${f.label} ${f.unit}`)) if (around.has(w) || around.has(`${w}s`) || around.has(w.replace(/s$/, ''))) score++
    // between equally worded facts, the one closest in size
    const gap = n.value === null ? 0 : Math.abs(Math.log10(Math.abs(n.value) + 1) - Math.log10(Math.abs(f.value) + 1))
    if (score > bestScore || (score === bestScore && score > 0 && gap < bestGap)) {
      best = f
      bestScore = score
      bestGap = gap
    }
  }
  return best
}

/**
 * Numbers may only enter text as {Fxx}. Anything else is checked against the run's facts.
 * `facts` should be every fact of the run: ids are looked up among all of them, bare numbers
 * are matched against the current value of each key.
 */
export function verify(text: string, facts: Fact[], channel: VerifyChannel): Verified {
  const byId = new Map(facts.map((f) => [f.id, f]))
  const replaced = new Set(facts.map((f) => f.supersedes).filter(Boolean) as string[])
  const current = facts.filter((f) => !replaced.has(f.id))
  const findings: Finding[] = []
  const factIds: string[] = []

  const rendered = text.replace(
    PLACEHOLDER_NEXT,
    (whole, words: string | undefined, before: string | undefined, id: string, after: string | undefined) => {
      const f = byId.get(id)
      if (!f) {
        findings.push({ kind: 'unknown_fact', text: `{${id}}` })
        return whole
      }
      factIds.push(id)
      let shown = channel === 'voice' ? f.spoken : f.display
      const glued = before && !shown.startsWith(before) ? before : ''
      const lead = glued ? (words ?? '') : dropRepeatedLead(words ?? '', shown)
      // the dropped words began a sentence
      if (!glued && words && lead.length < words.length && /^[A-Z]/.test(words.slice(lead.length))) shown = shown[0]!.toUpperCase() + shown.slice(1)
      return lead + glued + shown + (after && !repeatsUnit(shown, after) ? after : '')
    },
  )
  const labels = current.map((f) => ` ${f.label.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ')} `)

  // blank out the placeholders so their digits aren't read as bare numbers
  const scan = text.replace(PLACEHOLDER, (m) => ' '.repeat(m.length))
  let uncitedOk = 0
  if (channel !== 'extraction') {
    for (const n of findNumbers(scan)) {
      if (ALWAYS_OK.has(n.text)) continue
      if ((n.kind === 'words' || n.kind === 'digits') && namesAWindow(n, scan, labels)) continue
      const hit = current.find((f) => matches(n, f))
      const about = hit ?? likelyFact(n, scan, current)
      if (hit && channel === 'voice') {
        uncitedOk++
        factIds.push(hit.id)
        findings.push({ kind: 'uncited_match', text: n.text, fact_id: hit.id, source: hit.source })
      } else {
        findings.push({
          kind: 'bare_number',
          text: n.text,
          ...(about ? { fact_id: about.id, expected: about.display, source: about.source } : {}),
        })
      }
    }
  }

  const blocking = findings.some((f) => f.kind === 'unknown_fact' || f.kind === 'bare_number')
  if (blocking) {
    return { rendered: channel === 'voice' ? SAFE_LINE : rendered, verdict: 'block', findings, factIds }
  }
  return { rendered, verdict: uncitedOk ? 'pass_with_note' : 'pass', findings, factIds: [...new Set(factIds)] }
}

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim()

// Scout extraction: a field only counts if its quote really is on the page.
export function quoteOnPage(quote: string, pageText: string): boolean {
  const q = squash(quote)
  return q.length >= 3 && squash(pageText).includes(q)
}

// For the staged demo: puts a wrong, uncited number into a finished draft.
export function injectWrongNumber(text: string, fact: Fact): { text: string; wrong: number } {
  const real = typeof fact.value === 'number' ? fact.value : numberIn(fact.display) ?? 100
  const wrong = Math.round(real * 1.37) + 3
  const marker = `{${fact.id}}`
  const out = text.includes(marker) ? text.replace(marker, String(wrong)) : `${text} ${fact.label}: ${wrong}.`
  return { text: out, wrong }
}
