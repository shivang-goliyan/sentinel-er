import { describe, expect, it } from 'vitest'
import { LogEntry, type Fact, type LogEntry as Entry } from '@sentinel/shared'
import { activeRun, currentFacts, emptyState, endedCalls, FEED_LIMIT, fold, foldAll, pendingApprovals } from '../src/store/fold'
import { feedLine, tPlus } from '../src/lib/format'

const HASH = 'a'.repeat(64)
let seq = 0
const t0 = Date.parse('2026-09-19T13:30:00.000Z')

function entry(kind: string, payload: unknown, opts: { run?: string | null; actor?: string; at?: number } = {}): Entry {
  seq += 1
  return LogEntry.parse({
    seq,
    ts: new Date(t0 + (opts.at ?? seq) * 1000).toISOString(),
    run_id: opts.run === undefined ? 'run-1' : opts.run,
    actor: opts.actor ?? 'orchestrator',
    prev_hash: HASH,
    hash: HASH,
    kind,
    payload,
  }) as Entry
}

function fact(id: string, key: string, value: number, extra: Partial<Fact> = {}) {
  return {
    id,
    run_id: 'run-1',
    key,
    label: key,
    value,
    unit: 'beds',
    display: String(value),
    spoken: String(value),
    source: { name: 'CMS POS', retrieved_at: '2026-09-19T13:00:00.000Z', method: 'dataset' },
    created_at: '2026-09-19T13:30:05.000Z',
    ...extra,
  }
}

const started = () =>
  entry(
    'run.started',
    { event_id: 'drill-1', mode: 'drill', title: 'M6.4 drill near Alexandria', detected_at: '2026-09-19T13:30:00.000Z' },
    { at: 1 },
  )

describe('fold', () => {
  it('ignores already seen entries', () => {
    seq = 0
    const a = entry('note', { text: 'hello' }, { run: null, actor: 'operator' })
    const once = fold(emptyState(), a)
    expect(fold(once, a)).toBe(once)
    expect(once.feed).toHaveLength(1)
  })

  it('tracks latest crew status', () => {
    seq = 0
    const s = foldAll([
      entry('status', { text: 'reading USGS' }, { actor: 'feeds' }),
      entry('status', { text: 'done', state: 'done' }, { actor: 'feeds' }),
    ])
    expect(s.crew.feeds?.text).toBe('done')
    expect(s.crew.feeds?.state).toBe('done')
  })

  it('stamps ledger milestones once', () => {
    seq = 0
    const s = foldAll([
      started(),
      entry('ledger', { milestone: 'detected' }, { at: 2 }),
      entry('ledger', { milestone: 'context_built' }, { at: 40 }),
      entry('ledger', { milestone: 'context_built' }, { at: 90 }),
    ])
    const run = activeRun(s)!
    expect(run.title).toBe('M6.4 drill near Alexandria')
    expect(tPlus(run.detected_at, run.ledger.context_built!)).toBe('T+0:40')
  })

  it('keeps ended run active', () => {
    seq = 0
    const s = foldAll([started(), entry('run.ended', { status: 'done' })])
    expect(s.activeRunId).toBe('run-1')
    expect(s.runs['run-1']?.ended?.status).toBe('done')
  })

  it('hides superseded facts', () => {
    seq = 0
    const s = foldAll([
      started(),
      entry('fact', { fact: fact('F1', 'hospital.x.beds', 318) }),
      entry('fact', { fact: fact('F2', 'hospital.x.beds', 312, { supersedes: 'F1' }) }),
      entry('fact', { fact: fact('F3', 'hospital.y.beds', 90) }),
    ])
    expect(currentFacts(s, 'run-1').map((f) => f.id)).toEqual(['F2', 'F3'])
    expect(s.superseded.F1).toBe(true)
  })

  it('follows a call end to end', () => {
    seq = 0
    const s = foldAll([
      started(),
      entry('approval.requested', {
        approval_id: 'ap1',
        action: { type: 'call', role: 'charge_nurse', party_label: 'Inova Alexandria ED', reason: 'surge' },
      }),
      entry('call.queued', { call_id: 'q1', role: 'charge_nurse', party_label: 'Inova Alexandria ED' }),
      entry('approval.decided', { approval_id: 'ap1', decision: 'approved', by: 'operator' }),
      entry('call.started', { call_sid: 'CA1', role: 'charge_nurse', direction: 'out', party_label: 'Inova Alexandria ED' }),
      entry('call.said', { call_sid: 'CA1', text: 'Expect {F2} beds', verdict: 'pass', fact_ids: ['F2'] }),
      entry('call.heard', { call_sid: 'CA1', text: 'acknowledged' }),
      entry('call.ended', { call_sid: 'CA1', status: 'completed', duration_s: 74, acknowledged: true }),
    ])
    expect(pendingApprovals(s)).toHaveLength(0)
    expect(s.queue).toHaveLength(0)
    expect(s.activeCallSid).toBeNull()
    const [call] = endedCalls(s)
    expect(call?.lines.map((l) => l.who)).toEqual(['agent', 'caller'])
    expect(call?.acknowledged).toBe(true)
  })

  it('records busy line attempts', () => {
    seq = 0
    const s = foldAll([entry('call.busy', { from_label: '••• ••• 0123' }, { run: null })])
    expect(s.busy).toHaveLength(1)
  })

  it('applies switches from log', () => {
    seq = 0
    const s = foldAll([
      entry('switch.changed', { name: 'approval', on: false }, { run: null, actor: 'operator' }),
      entry('switch.changed', { name: 'drill', on: true }, { run: null, actor: 'operator' }),
    ])
    expect(s.switches).toEqual({ approval: false, drill: true })
  })

  it('removes whitelist entries', () => {
    seq = 0
    const add = { label: 'Team phone', role: 'charge_nurse', masked: '••• ••• 0123' }
    const s = foldAll([
      entry('whitelist.changed', add, { run: null, actor: 'operator' }),
      entry('whitelist.changed', { ...add, removed: true }, { run: null, actor: 'operator' }),
    ])
    expect(Object.keys(s.whitelist)).toHaveLength(0)
  })

  it('bounds the action feed', () => {
    seq = 0
    const many = Array.from({ length: FEED_LIMIT + 25 }, (_, i) => entry('note', { text: `n${i}` }, { run: null }))
    const s = foldAll(many)
    expect(s.feed).toHaveLength(FEED_LIMIT)
    expect(s.feed.at(-1)?.seq).toBe(FEED_LIMIT + 25)
  })

  it('collects verifier blocks', () => {
    seq = 0
    const s = foldAll([
      started(),
      entry('verify.block', {
        channel: 'sitrep',
        target: 'draft 1',
        text: 'Inova Alexandria has 400 beds',
        findings: [{ kind: 'bare_number', text: '400 is not a known fact', expected: '312' }],
      }),
    ])
    expect(s.verify[0]?.verdict).toBe('block')
    expect(feedLine(s.feed[1]!).tone).toBe('bad')
  })
})

describe('format', () => {
  it('formats hours past sixty', () => {
    expect(tPlus('2026-09-19T13:30:00.000Z', '2026-09-19T14:32:05.000Z')).toBe('T+1:02:05')
  })

  it('has a line for every kind', () => {
    seq = 0
    const e = entry('anchor.submitted', { head_seq: 12, head_hash: HASH }, { run: null })
    expect(feedLine(e).text).toContain('#12')
  })
})
