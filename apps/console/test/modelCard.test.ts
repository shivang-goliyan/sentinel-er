import { describe, expect, it } from 'vitest'
import { cardSummary, eventName, readCard } from '../src/lib/modelCard'

// trimmed from GET /api/models/casualty
const served = {
  metrics: {
    default_variant: 'without_pager_alert',
    cv: {
      without_pager_alert: {
        deaths: { rows_1000_plus: { rows: 59, median_abs_log10_error: 1.6328, interval_80_coverage: 0.322 } },
      },
    },
  },
  charts: {
    holdout: [
      { event: 'turkey-2023', target: 'deaths', p10: 88, p50: 4070, p90: 55385, ncei: 56697, official: 53537, pager_baseline: 21573 },
      { event: 'nepal-2015', target: 'deaths', p10: 33, p50: 990, p90: 14876, ncei: 8957, official: 8790, pager_baseline: 6140 },
      { event: 'turkey-2023', target: 'injured', p10: 5641, p50: 35067, p90: 155705, ncei: 119200, official: 107213, pager_baseline: null },
      { event: 'nepal-2015', target: 'injured', p10: 2693, p50: 18669, p90: 42014, ncei: 24000, official: 22300, pager_baseline: null },
      { event: 'bad', target: 'other', p10: 1, p50: 2, p90: 3 },
    ],
    cv_calibration: [
      { event_id: 'ci1', deaths: 2, pred_p10: 12.1, pred_p50: 419.6, pred_p90: 3657.5 },
      { event_id: 'broken', deaths: 'x' },
    ],
    bias: {
      Low: { rows: 1439, rows_with_deaths: 182, coverage_weighted: 0.956, bin_accuracy_weighted: 0.83, median_residual_log10_deadly: -0.434, coverage_deadly: 0.687 },
      High: { rows: 1900, rows_with_deaths: 113, coverage_weighted: 0.993, bin_accuracy_weighted: 0.974, median_residual_log10_deadly: -0.301, coverage_deadly: 0.708 },
    },
  },
}

describe('model card', () => {
  it('reads the served card', () => {
    const card = readCard(served)!
    expect(card.holdout).toHaveLength(4)
    expect(card.calibration).toHaveLength(1)
    expect(card.bias.map((b) => b.name)).toEqual(['Low', 'High'])
    expect(card.catastrophic).toEqual({ rows: 59, median_abs_log10_error: 1.6328, interval_80_coverage: 0.322 })
  })

  it('rejects unknown shapes', () => {
    expect(readCard(null)).toBeNull()
    expect(readCard({ charts: {} })).toBeNull()
  })

  it('summary quotes only card numbers', () => {
    const text = cardSummary(readCard(served)!).join(' ')
    expect(text).toContain('median under-predicts deaths')
    expect(text).toContain('Turkey 2023: median 4,070 against 56,697 recorded')
    expect(text).toContain("holds Nepal 2015's deaths and both injury counts")
    expect(text).toContain("Turkey 2023's 56,697 deaths sit above its top end, 55,385")
    expect(text).toContain("PAGER's empirical estimate lands closer to the recorded deaths than our median on both")
    expect(text).toContain('the 59 training quakes')
    expect(text).toContain('1.6 orders of magnitude')
    expect(text).toContain('32% of the time')
    const numbers = text.match(/\d[\d,.]*/g)!.map((n) => n.replace(/[,.]$/, ''))
    // 10 and 90 name the band, 1,000 names the bucket
    const allowed = ['4,070', '56,697', '990', '8,957', '55,385', '59', '1,000', '1.6', '32', '2023', '2015', '10', '90']
    expect(numbers.filter((n) => !allowed.includes(n))).toEqual([])
  })

  it('credits the model when closer', () => {
    const closer = structuredClone(served)
    for (const r of closer.charts.holdout) if (r.target === 'deaths') r.pager_baseline = 1
    const text = cardSummary(readCard(closer)!).join(' ')
    expect(text).toContain('Our median lands closer')
  })

  it('names events for people', () => {
    expect(eventName('turkey-2023')).toBe('Turkey 2023')
    expect(eventName('new-zealand-2011')).toBe('New zealand 2011')
    expect(eventName('replay')).toBe('Replay')
  })
})
