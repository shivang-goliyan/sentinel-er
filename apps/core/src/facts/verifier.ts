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
const ALWAYS_OK = new Set(['911'])

function close(a: number, b: number, tol: Fact['tolerance']) {
  const abs = tol.abs ?? 0
  const rel = tol.rel ?? 0
  const slack = Math.max(abs, Math.abs(b) * rel)
  return Math.abs(a - b) <= slack + 1e-9
}

function matches(n: FoundNumber, f: Fact): boolean {
  if (n.value === null) return false
  if (typeof f.value === 'string') {
    // text facts can hold numbers too (ZIP codes, street numbers, phone numbers)
    const digits = f.display.replace(/\D/g, '')
    return digits.length > 0 && digits.includes(n.text.replace(/\D/g, ''))
  }
  if (close(n.value, f.value, f.tolerance)) return true
  if (f.unit === 'probability' && close(n.value, f.value * 100, { abs: 0.5 })) return true
  const shown = numberIn(f.display)
  return shown !== null && close(n.value, shown, { abs: 0 })
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

  const rendered = text.replace(PLACEHOLDER, (whole, id: string) => {
    const f = byId.get(id)
    if (!f) {
      findings.push({ kind: 'unknown_fact', text: whole })
      return whole
    }
    factIds.push(id)
    return channel === 'voice' ? f.spoken : f.display
  })

  // blank out the placeholders so their digits aren't read as bare numbers
  const scan = text.replace(PLACEHOLDER, (m) => ' '.repeat(m.length))
  let uncitedOk = 0
  if (channel !== 'extraction') {
    for (const n of findNumbers(scan)) {
      if (ALWAYS_OK.has(n.text)) continue
      const hit = current.find((f) => matches(n, f))
      if (hit && channel === 'voice') {
        uncitedOk++
        factIds.push(hit.id)
        findings.push({ kind: 'uncited_match', text: n.text, fact_id: hit.id, source: hit.source })
      } else {
        findings.push({
          kind: 'bare_number',
          text: n.text,
          ...(hit ? { fact_id: hit.id, expected: hit.display, source: hit.source } : {}),
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
