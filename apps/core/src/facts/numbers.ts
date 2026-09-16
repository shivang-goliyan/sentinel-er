// Finds every number a sentence claims, whether written as digits or words.

export interface FoundNumber {
  text: string
  start: number
  end: number
  // null for vague amounts like "hundreds of"
  value: number | null
  kind: 'digits' | 'words' | 'percent' | 'time' | 'vague'
}

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
}
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}
const SCALES: Record<string, number> = { hundred: 100, thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 }
const VAGUE = /\b(?:dozens|scores|hundreds|thousands|millions)\b/gi

const WORD = Object.keys({ ...SMALL, ...TENS, ...SCALES, dozen: 1 }).join('|')
// a run of number words, allowing "and" and hyphens between them: "three hundred and twenty-one"
const WORD_RUN = new RegExp(`\\b(?:${WORD})(?:(?:[\\s-]+|\\s+and\\s+)(?:${WORD}))*\\b`, 'gi')

function wordsToNumber(phrase: string): number | null {
  const parts = phrase.toLowerCase().split(/[\s-]+/).filter((p) => p && p !== 'and')
  let total = 0
  let current = 0
  for (const p of parts) {
    if (p === 'dozen') {
      current = (current || 1) * 12
    } else if (p in SMALL) current += SMALL[p]!
    else if (p in TENS) current += TENS[p]!
    else if (p === 'hundred') current = (current || 1) * 100
    else if (p in SCALES) {
      total += (current || 1) * SCALES[p]!
      current = 0
    } else return null
  }
  return total + current
}

export function findNumbers(text: string): FoundNumber[] {
  const found: FoundNumber[] = []
  const taken: [number, number][] = []
  const free = (s: number, e: number) => taken.every(([a, b]) => e <= a || s >= b)
  const push = (n: FoundNumber) => {
    if (!free(n.start, n.end)) return
    taken.push([n.start, n.end])
    found.push(n)
  }

  for (const m of text.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)) {
    push({ text: m[0], start: m.index, end: m.index + m[0].length, value: Number(m[1]) * 60 + Number(m[2]), kind: 'time' })
  }
  for (const m of text.matchAll(/(?<![\w.])\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|(?<![\w.])\d+(?:\.\d+)?%?/g)) {
    const raw = m[0]
    const pct = raw.endsWith('%')
    const value = Number(raw.replace(/[,%]/g, ''))
    let end = m.index + raw.length
    let kind: FoundNumber['kind'] = pct ? 'percent' : 'digits'
    if (!pct && /^\s*(?:percent|per cent)\b/i.test(text.slice(end))) {
      end += text.slice(end).match(/^\s*(?:percent|per cent)/i)![0].length
      kind = 'percent'
    }
    push({ text: text.slice(m.index, end), start: m.index, end, value, kind })
  }
  for (const m of text.matchAll(WORD_RUN)) {
    const phrase = m[0]
    const lower = phrase.toLowerCase()
    // "one" on its own is nearly always a pronoun ("the one filling first"), not a claim
    if (lower === 'one') continue
    const value = wordsToNumber(phrase)
    if (value === null) continue
    let end = m.index + phrase.length
    let kind: FoundNumber['kind'] = 'words'
    if (/^\s*(?:percent|per cent)\b/i.test(text.slice(end))) {
      end += text.slice(end).match(/^\s*(?:percent|per cent)/i)![0].length
      kind = 'percent'
    }
    push({ text: text.slice(m.index, end), start: m.index, end, value, kind })
  }
  for (const m of text.matchAll(VAGUE)) {
    push({ text: m[0], start: m.index, end: m.index + m[0].length, value: null, kind: 'vague' })
  }
  return found.sort((a, b) => a.start - b.start)
}

// Pulls the number out of a fact's display string: "312" → 312, "41%" → 41, "M6.4" → 6.4
export function numberIn(display: string): number | null {
  const m = display.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
  return m ? Number(m[0]) : null
}
