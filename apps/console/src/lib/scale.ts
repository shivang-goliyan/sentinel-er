// log(1 + x) axes: they keep zero on the chart, which a plain log axis can't.

export const lg = (v: number) => Math.log10(1 + Math.max(0, v))

// smallest power of ten at or above max, and never below 10
export function decadeTop(max: number): number {
  if (!Number.isFinite(max) || max <= 10) return 10
  return 10 ** Math.ceil(Math.log10(max) - 1e-9)
}

export function decades(top: number): number[] {
  const out = [0]
  for (let d = 1; d <= top; d *= 10) out.push(d)
  return out
}

// 0..1 along an axis that runs from 0 to top
export function logPos(v: number, top: number): number {
  return Math.min(1, lg(v) / lg(top))
}

export function shortCount(v: number): string {
  if (v >= 1_000_000) return `${v / 1_000_000}M`
  if (v >= 1000) return `${v / 1000}k`
  return String(v)
}
