// Checked on every caller turn before the model sees it. A match ends the automated part of the
// call: the caller is told to dial 911 and, in a drill, handed to a person on the whitelist.
const PATTERNS: RegExp[] = [
  /\bchest (?:pain|pressure|tightness)\b/i,
  /\bheart attack\b/i,
  /\b(?:not|isn'?t|stopped|can'?t|cannot|can not) breath(?:e|ing)\b/i,
  /\b(?:struggling|trouble|difficulty) breathing\b/i,
  /\bchoking\b/i,
  /\bunconscious\b|\bpassed out\b|\bwon'?t wake\b|\bnot waking\b|\bunresponsive\b/i,
  /\b(?:not|isn'?t) responding\b/i,
  /\bbleeding (?:a lot|heavily|badly|won'?t stop)\b|\blots of blood\b|\bheavy bleeding\b/i,
  /\bstroke\b|\bface (?:is )?droop/i,
  /\bseizure\b|\bfitting\b/i,
  /\boverdos(?:e|ed)\b/i,
  /\bsuicid|\bkill (?:my|him|her)self\b|\bend (?:my|his|her) life\b/i,
  /\bnot breathing\b|\bno pulse\b|\bturning blue\b/i,
  /\b(?:crushed|trapped) under\b/i,
  /\bin labou?r\b|\bbaby (?:is )?coming\b/i,
  /\bsevere (?:burns?|allergic)\b|\banaphyla/i,
]

export function redFlag(text: string): string | null {
  for (const p of PATTERNS) {
    const m = text.match(p)
    if (m) return m[0]
  }
  return null
}

export const EMERGENCY_LINE =
  'This sounds like a medical emergency. Please hang up now and dial 911. I am connecting you to a person as well.'
