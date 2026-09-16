// The casualty model card as served by /api/models/casualty, and the plain-English reading of it.
// Every figure in the summary is read out of the card.

export type HoldoutRow = {
  event: string
  target: 'deaths' | 'injured'
  p10: number
  p50: number
  p90: number
  ncei: number | null
  official: number | null
  pager_baseline: number | null
}

export type CalibrationPoint = { event_id: string; deaths: number; pred_p10: number; pred_p50: number; pred_p90: number }

export type BiasGroup = {
  rows: number
  rows_with_deaths: number
  coverage_weighted: number
  bin_accuracy_weighted: number
  median_residual_log10_deadly: number | null
  coverage_deadly: number | null
}

export type Score = { rows: number; median_abs_log10_error: number; interval_80_coverage: number }

export type CasualtyCard = {
  holdout: HoldoutRow[]
  calibration: CalibrationPoint[]
  bias: { name: string; group: BiasGroup }[]
  catastrophic: Score | null
  variant: string | null
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function readCard(json: unknown): CasualtyCard | null {
  if (!isObj(json) || !isObj(json.charts) || !isObj(json.metrics)) return null
  const { charts, metrics } = json

  const holdout: HoldoutRow[] = Array.isArray(charts.holdout)
    ? charts.holdout.flatMap((r) => {
        if (!isObj(r) || typeof r.event !== 'string') return []
        if (r.target !== 'deaths' && r.target !== 'injured') return []
        const [p10, p50, p90] = [num(r.p10), num(r.p50), num(r.p90)]
        if (p10 === null || p50 === null || p90 === null) return []
        return [{ event: r.event, target: r.target, p10, p50, p90, ncei: num(r.ncei), official: num(r.official), pager_baseline: num(r.pager_baseline) }]
      })
    : []

  const calibration: CalibrationPoint[] = Array.isArray(charts.cv_calibration)
    ? charts.cv_calibration.flatMap((r) => {
        if (!isObj(r)) return []
        const [deaths, lo, mid, hi] = [num(r.deaths), num(r.pred_p10), num(r.pred_p50), num(r.pred_p90)]
        if (deaths === null || lo === null || mid === null || hi === null) return []
        return [{ event_id: String(r.event_id ?? ''), deaths, pred_p10: lo, pred_p50: mid, pred_p90: hi }]
      })
    : []

  const bias = isObj(charts.bias)
    ? Object.entries(charts.bias).flatMap(([name, g]) => {
        if (!isObj(g)) return []
        const rows = num(g.rows)
        const withDeaths = num(g.rows_with_deaths)
        if (rows === null || withDeaths === null) return []
        return [
          {
            name,
            group: {
              rows,
              rows_with_deaths: withDeaths,
              coverage_weighted: num(g.coverage_weighted) ?? 0,
              bin_accuracy_weighted: num(g.bin_accuracy_weighted) ?? 0,
              median_residual_log10_deadly: num(g.median_residual_log10_deadly),
              coverage_deadly: num(g.coverage_deadly),
            },
          },
        ]
      })
    : []

  const variant = typeof metrics.default_variant === 'string' ? metrics.default_variant : null
  let catastrophic: Score | null = null
  const cv = isObj(metrics.cv) && variant ? metrics.cv[variant] : undefined
  const big = isObj(cv) && isObj(cv.deaths) ? cv.deaths.rows_1000_plus : undefined
  if (isObj(big)) {
    const [rows, err, cover] = [num(big.rows), num(big.median_abs_log10_error), num(big.interval_80_coverage)]
    if (rows !== null && err !== null && cover !== null) catastrophic = { rows, median_abs_log10_error: err, interval_80_coverage: cover }
  }

  return { holdout, calibration, bias, catastrophic, variant }
}

export function eventName(id: string): string {
  const m = /^(.*)-(\d{4})$/.exec(id)
  const name = (m ? m[1]! : id).replace(/-/g, ' ')
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}${m ? ` ${m[2]}` : ''}`
}

export const count = (n: number) => Math.round(n).toLocaleString('en-US')
export const pct = (share: number) => `${Math.round(share * 100)}%`

// distance on the log scale the model is scored on
const miss = (a: number, b: number) => Math.abs(Math.log10(a + 1) - Math.log10(b + 1))

export function cardSummary(card: CasualtyCard): string[] {
  const out: string[] = []
  const deaths = card.holdout.filter((r) => r.target === 'deaths' && r.ncei !== null)

  if (deaths.length) {
    const under = deaths.filter((r) => r.p50 < r.ncei!)
    const parts = deaths.map((r) => `${eventName(r.event)}: median ${count(r.p50)} against ${count(r.ncei!)} recorded`)
    const lead =
      under.length === deaths.length
        ? `On the quakes it never saw, the median under-predicts deaths`
        : `On the quakes it never saw`
    out.push(`${lead} (${parts.join('; ')}).`)

    const held = deaths.filter((r) => r.ncei! >= r.p10 && r.ncei! <= r.p90)
    const missed = deaths.filter((r) => !held.includes(r))
    const injuredHeld = card.holdout.filter((r) => r.target === 'injured' && r.ncei !== null && r.ncei >= r.p10 && r.ncei <= r.p90)
    const heldBits = [
      ...held.map((r) => `${eventName(r.event)}'s deaths`),
      ...(injuredHeld.length ? [injuredHeld.length === 1 ? `${eventName(injuredHeld[0]!.event)}'s injuries` : `${injuredHeld.length === 2 ? 'both' : 'all'} injury counts`] : []),
    ]
    let band = heldBits.length ? `The 10–90% band holds ${heldBits.join(' and ')}` : 'The 10–90% band misses every held-out count'
    const shortOf = missed.map((r) =>
      r.ncei! > r.p90
        ? `${eventName(r.event)}'s ${count(r.ncei!)} deaths sit above its top end, ${count(r.p90)}`
        : `${eventName(r.event)}'s ${count(r.ncei!)} deaths sit below its low end, ${count(r.p10)}`,
    )
    if (heldBits.length && shortOf.length) band += `; ${shortOf.join('; ')}`
    out.push(`${band}.`)

    const pager = deaths.filter((r) => r.pager_baseline !== null)
    if (pager.length) {
      const closer = pager.filter((r) => miss(r.pager_baseline!, r.ncei!) < miss(r.p50, r.ncei!))
      const which =
        closer.length === pager.length
          ? pager.length === 1
            ? 'on it'
            : `on ${pager.length === 2 ? 'both' : 'all of them'}`
          : closer.length
            ? `on ${closer.map((r) => eventName(r.event)).join(' and ')}`
            : ''
      out.push(
        closer.length
          ? `USGS PAGER's empirical estimate lands closer to the recorded deaths than our median ${which}.`
          : `Our median lands closer to the recorded deaths than USGS PAGER's empirical estimate.`,
      )
    }
  }

  const c = card.catastrophic
  if (c) {
    out.push(
      `Across the ${count(c.rows)} training quakes that killed 1,000 or more, scored out of fold, the median was typically ${c.median_abs_log10_error.toFixed(1)} orders of magnitude off and the band held the truth ${pct(c.interval_80_coverage)} of the time.`,
    )
  }
  if (out.length) out.push('That is why the console plans on the high end of the band and labels every casualty figure a screening estimate.')
  return out
}
