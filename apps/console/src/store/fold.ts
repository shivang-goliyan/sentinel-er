import type {
  Actor,
  CallRole,
  Fact,
  Finding,
  HazardEvent,
  LogEntry,
  Milestone,
  PayloadOf,
  RunMode,
} from '@sentinel/shared'

// Everything on screen is derived here from log entries, in log order. No clocks, no fetches:
// replaying the same entries must give the same screen.

export const FEED_LIMIT = 400
const LIST_LIMIT = 200

export type CrewLine = { text: string; state: PayloadOf<'status'>['state']; ts: string; seq: number; run_id: string | null }

export type RunView = {
  id: string
  event_id: string
  mode: RunMode
  title: string
  as_of: string | null
  detected_at: string
  started_at: string
  ledger: Partial<Record<Milestone, string>>
  ended: { status: PayloadOf<'run.ended'>['status']; note?: string; ts: string } | null
}

export type TranscriptLine = {
  seq: number
  ts: string
  who: 'caller' | 'agent' | 'tool' | 'system'
  text: string
  verdict?: PayloadOf<'call.said'>['verdict']
  fact_ids?: string[]
}

export type CallView = {
  sid: string
  run_id: string | null
  role: CallRole
  direction: 'in' | 'out'
  party_label: string
  test: boolean
  started_at: string
  ended_at: string | null
  status: string | null
  duration_s: number | null
  acknowledged: boolean
  handoff: string | null
  lines: TranscriptLine[]
}

export type QueuedCall = { call_id: string; run_id: string | null; role: CallRole; party_label: string; ts: string }

export type ApprovalView = {
  id: string
  run_id: string | null
  action: PayloadOf<'approval.requested'>['action']
  requested_at: string
  decision: 'approved' | 'declined' | null
  decided_at: string | null
  by: string | null
}

export type VerifyView = {
  seq: number
  ts: string
  run_id: string | null
  channel: PayloadOf<'verify.pass'>['channel']
  target: string
  verdict: 'pass' | 'block'
  findings: Finding[]
  text?: string
}

export type SitrepView = {
  drafts: { attempt: number; text: string; ts: string; seq: number }[]
  final: { text: string; template: boolean; fact_ids: string[]; ts: string } | null
}

export type Stamped<T> = T & { ts: string; seq: number; run_id: string | null }

export type LayerView = Stamped<PayloadOf<'layer'>>

// Fact ids restart at F1 for every run, so the console keys them by run as well.
export const factRef = (runId: string, id: string) => `${runId}/${id}`
// run id (or NO_RUN) → layer name → latest layer
export const NO_RUN = '-'

export type ConsoleState = {
  head: number
  crew: Partial<Record<Actor, CrewLine>>
  events: Record<string, HazardEvent>
  eventTiers: Record<string, { tier: number; reason: string; ts: string }>
  runs: Record<string, RunView>
  runOrder: string[]
  activeRunId: string | null
  facts: Record<string, Fact>
  factOrder: string[]
  latestFactByKey: Record<string, string>
  superseded: Record<string, true>
  sitreps: Record<string, SitrepView>
  verify: VerifyView[]
  models: Stamped<PayloadOf<'model.output'>>[]
  approvals: Record<string, ApprovalView>
  approvalOrder: string[]
  calls: Record<string, CallView>
  callOrder: string[]
  activeCallSid: string | null
  queue: QueuedCall[]
  busy: Stamped<PayloadOf<'call.busy'>>[]
  artifacts: Stamped<PayloadOf<'artifact'>>[]
  fetches: Stamped<PayloadOf<'fetch'>>[]
  capacity: Record<string, Stamped<PayloadOf<'capacity.updated'>>>
  switches: { approval: boolean | null; drill: boolean | null }
  whitelist: Record<string, Stamped<PayloadOf<'whitelist.changed'>>>
  anchors: {
    submitted: Stamped<PayloadOf<'anchor.submitted'>>[]
    confirmed: Stamped<PayloadOf<'anchor.confirmed'>>[]
  }
  fallbacks: Stamped<PayloadOf<'fallback.used'>>[]
  faults: Stamped<PayloadOf<'fault.injected'>>[]
  errors: Stamped<PayloadOf<'error'>>[]
  layers: Record<string, Record<string, LayerView>>
  feed: LogEntry[]
}

export function emptyState(): ConsoleState {
  return {
    head: 0,
    crew: {},
    events: {},
    eventTiers: {},
    runs: {},
    runOrder: [],
    activeRunId: null,
    facts: {},
    factOrder: [],
    latestFactByKey: {},
    superseded: {},
    sitreps: {},
    verify: [],
    models: [],
    approvals: {},
    approvalOrder: [],
    calls: {},
    callOrder: [],
    activeCallSid: null,
    queue: [],
    busy: [],
    artifacts: [],
    fetches: [],
    capacity: {},
    switches: { approval: null, drill: null },
    whitelist: {},
    anchors: { submitted: [], confirmed: [] },
    fallbacks: [],
    faults: [],
    errors: [],
    layers: {},
    feed: [],
  }
}

function capped<T>(list: T[], item: T, limit = LIST_LIMIT): T[] {
  const next = list.length >= limit ? list.slice(list.length - limit + 1) : list.slice()
  next.push(item)
  return next
}

function stamp<T extends object>(e: LogEntry, payload: T): Stamped<T> {
  return { ...payload, ts: e.ts, seq: e.seq, run_id: e.run_id }
}

function updateCall(s: ConsoleState, sid: string, fn: (c: CallView) => CallView): ConsoleState {
  const call = s.calls[sid]
  if (!call) return s
  return { ...s, calls: { ...s.calls, [sid]: fn(call) } }
}

function addLine(s: ConsoleState, sid: string, line: TranscriptLine): ConsoleState {
  return updateCall(s, sid, (c) => ({ ...c, lines: [...c.lines, line] }))
}

function sitrepFor(s: ConsoleState, runId: string): SitrepView {
  return s.sitreps[runId] ?? { drafts: [], final: null }
}

export function fold(state: ConsoleState, e: LogEntry): ConsoleState {
  // entries arrive at-least-once over SSE; anything at or below head is already in
  if (e.seq <= state.head) return state

  // the feed only needs a one-liner; map payloads can be hundreds of KB
  const forFeed: LogEntry =
    e.kind === 'layer' ? { ...e, payload: { ...e.payload, geojson: { type: 'FeatureCollection', features: [] } } } : e
  let s: ConsoleState = { ...state, head: e.seq, feed: capped(state.feed, forFeed, FEED_LIMIT) }

  switch (e.kind) {
    case 'status':
      s.crew = {
        ...s.crew,
        [e.actor]: { text: e.payload.text, state: e.payload.state, ts: e.ts, seq: e.seq, run_id: e.run_id },
      }
      break

    case 'event.detected': {
      const ev = e.payload.event
      s.events = { ...s.events, [ev.id]: ev }
      break
    }

    case 'event.tiered':
      s.eventTiers = {
        ...s.eventTiers,
        [e.payload.event_id]: { tier: e.payload.tier, reason: e.payload.reason, ts: e.ts },
      }
      break

    case 'run.started': {
      if (!e.run_id) break
      const p = e.payload
      const run: RunView = {
        id: e.run_id,
        event_id: p.event_id,
        mode: p.mode,
        title: p.title,
        as_of: p.as_of,
        detected_at: p.detected_at,
        started_at: e.ts,
        ledger: {},
        ended: null,
      }
      s.runs = { ...s.runs, [run.id]: run }
      s.runOrder = s.runOrder.includes(run.id) ? s.runOrder : [...s.runOrder, run.id]
      s.activeRunId = run.id
      break
    }

    case 'run.ended': {
      const run = e.run_id ? s.runs[e.run_id] : undefined
      if (!run) break
      // the run stays active on screen so its ledger remains readable
      s.runs = {
        ...s.runs,
        [run.id]: { ...run, ended: { status: e.payload.status, note: e.payload.note, ts: e.ts } },
      }
      break
    }

    case 'ledger': {
      const run = e.run_id ? s.runs[e.run_id] : undefined
      if (!run || run.ledger[e.payload.milestone]) break
      s.runs = { ...s.runs, [run.id]: { ...run, ledger: { ...run.ledger, [e.payload.milestone]: e.ts } } }
      break
    }

    case 'fact': {
      const f = e.payload.fact
      const ref = factRef(f.run_id, f.id)
      s.facts = { ...s.facts, [ref]: f }
      s.factOrder = [...s.factOrder, ref]
      const scopedKey = `${f.run_id}:${f.key}`
      const prev = s.latestFactByKey[scopedKey]
      s.latestFactByKey = { ...s.latestFactByKey, [scopedKey]: ref }
      const gone = { ...s.superseded }
      if (f.supersedes) gone[factRef(f.run_id, f.supersedes)] = true
      if (prev && prev !== ref) gone[prev] = true
      s.superseded = gone
      break
    }

    case 'fetch':
      s.fetches = capped(s.fetches, stamp(e, e.payload))
      break

    case 'model.output':
      s.models = capped(s.models, stamp(e, e.payload))
      break

    case 'sitrep.draft': {
      if (!e.run_id) break
      const cur = sitrepFor(s, e.run_id)
      s.sitreps = {
        ...s.sitreps,
        [e.run_id]: {
          ...cur,
          drafts: [...cur.drafts, { attempt: e.payload.attempt, text: e.payload.text, ts: e.ts, seq: e.seq }],
        },
      }
      break
    }

    case 'sitrep.final': {
      if (!e.run_id) break
      const cur = sitrepFor(s, e.run_id)
      s.sitreps = { ...s.sitreps, [e.run_id]: { ...cur, final: { ...e.payload, ts: e.ts } } }
      break
    }

    case 'verify.pass':
    case 'verify.block':
      s.verify = capped(s.verify, {
        seq: e.seq,
        ts: e.ts,
        run_id: e.run_id,
        channel: e.payload.channel,
        target: e.payload.target,
        verdict: e.kind === 'verify.pass' ? 'pass' : 'block',
        findings: e.payload.findings,
        text: e.kind === 'verify.block' ? e.payload.text : undefined,
      })
      break

    case 'artifact':
      s.artifacts = capped(s.artifacts, stamp(e, e.payload))
      break

    case 'approval.requested': {
      const p = e.payload
      s.approvals = {
        ...s.approvals,
        [p.approval_id]: {
          id: p.approval_id,
          run_id: e.run_id,
          action: p.action,
          requested_at: e.ts,
          decision: null,
          decided_at: null,
          by: null,
        },
      }
      s.approvalOrder = [...s.approvalOrder, p.approval_id]
      break
    }

    case 'approval.decided': {
      const a = s.approvals[e.payload.approval_id]
      if (!a) break
      s.approvals = {
        ...s.approvals,
        [a.id]: { ...a, decision: e.payload.decision, decided_at: e.ts, by: e.payload.by },
      }
      break
    }

    case 'call.queued':
      s.queue = [
        ...s.queue,
        { call_id: e.payload.call_id, run_id: e.run_id, role: e.payload.role, party_label: e.payload.party_label, ts: e.ts },
      ]
      break

    case 'call.started': {
      const p = e.payload
      const call: CallView = {
        sid: p.call_sid,
        run_id: e.run_id,
        role: p.role,
        direction: p.direction,
        party_label: p.party_label,
        test: p.test,
        started_at: e.ts,
        ended_at: null,
        status: null,
        duration_s: null,
        acknowledged: false,
        handoff: null,
        lines: [],
      }
      s.calls = { ...s.calls, [call.sid]: call }
      s.callOrder = s.callOrder.includes(call.sid) ? s.callOrder : [...s.callOrder, call.sid]
      s.activeCallSid = call.sid
      // call.started doesn't carry the queue id, so the oldest matching queued call is the one that dialled
      if (p.direction === 'out') {
        const i = s.queue.findIndex((q) => q.role === p.role && q.party_label === p.party_label)
        if (i >= 0) s.queue = [...s.queue.slice(0, i), ...s.queue.slice(i + 1)]
      }
      break
    }

    case 'call.heard':
      s = addLine(s, e.payload.call_sid, { seq: e.seq, ts: e.ts, who: 'caller', text: e.payload.text })
      break

    case 'call.said':
      s = addLine(s, e.payload.call_sid, {
        seq: e.seq,
        ts: e.ts,
        who: 'agent',
        text: e.payload.text,
        verdict: e.payload.verdict,
        fact_ids: e.payload.fact_ids,
      })
      break

    case 'call.tool':
      s = addLine(s, e.payload.call_sid, {
        seq: e.seq,
        ts: e.ts,
        who: 'tool',
        text: `${e.payload.tool}: ${e.payload.summary}`,
      })
      break

    case 'call.handoff':
      s = addLine(s, e.payload.call_sid, { seq: e.seq, ts: e.ts, who: 'system', text: `Handed to a person: ${e.payload.reason}` })
      s = updateCall(s, e.payload.call_sid, (c) => ({ ...c, handoff: e.payload.reason }))
      break

    case 'call.busy':
      s.busy = capped(s.busy, stamp(e, e.payload))
      break

    case 'call.ended': {
      const p = e.payload
      s = updateCall(s, p.call_sid, (c) => ({
        ...c,
        ended_at: e.ts,
        status: p.status,
        duration_s: p.duration_s,
        acknowledged: c.acknowledged || p.acknowledged,
      }))
      if (s.activeCallSid === p.call_sid) s.activeCallSid = null
      break
    }

    case 'capacity.updated':
      s.capacity = { ...s.capacity, [e.payload.ccn]: stamp(e, e.payload) }
      break

    case 'anchor.submitted':
      s.anchors = { ...s.anchors, submitted: capped(s.anchors.submitted, stamp(e, e.payload)) }
      break

    case 'anchor.confirmed':
      s.anchors = { ...s.anchors, confirmed: capped(s.anchors.confirmed, stamp(e, e.payload)) }
      break

    case 'fallback.used':
      s.fallbacks = capped(s.fallbacks, stamp(e, e.payload))
      break

    case 'fault.injected':
      s.faults = capped(s.faults, stamp(e, e.payload))
      break

    case 'switch.changed':
      s.switches = { ...s.switches, [e.payload.name]: e.payload.on }
      break

    case 'whitelist.changed': {
      const p = e.payload
      const next = { ...s.whitelist }
      if (p.removed) delete next[p.masked]
      else next[p.masked] = stamp(e, p)
      s.whitelist = next
      break
    }

    case 'error':
      s.errors = capped(s.errors, stamp(e, e.payload))
      break

    case 'layer': {
      const key = e.run_id ?? NO_RUN
      s.layers = { ...s.layers, [key]: { ...(s.layers[key] ?? {}), [e.payload.name]: stamp(e, e.payload) } }
      break
    }

    case 'note':
      break
  }

  return s
}

// a stable empty object: selectors must return the same reference when nothing changed
const NO_LAYERS: Record<string, LayerView> = Object.freeze({}) as Record<string, LayerView>

export function layersFor(s: ConsoleState, runId: string | null): Record<string, LayerView> {
  return s.layers[runId ?? NO_RUN] ?? NO_LAYERS
}

export function foldAll(entries: LogEntry[], start: ConsoleState = emptyState()): ConsoleState {
  let s = start
  for (const e of entries) s = fold(s, e)
  return s
}

// --- selectors -------------------------------------------------------------

export function activeRun(s: ConsoleState): RunView | null {
  return s.activeRunId ? (s.runs[s.activeRunId] ?? null) : null
}

export function currentFacts(s: Pick<ConsoleState, 'factOrder' | 'facts' | 'superseded'>, runId: string | null): Fact[] {
  if (!runId) return []
  return s.factOrder
    .filter((ref) => !s.superseded[ref])
    .map((ref) => s.facts[ref])
    .filter((f): f is Fact => !!f && f.run_id === runId)
}

export function pendingApprovals(s: Pick<ConsoleState, 'approvalOrder' | 'approvals'>): ApprovalView[] {
  return s.approvalOrder.map((id) => s.approvals[id]).filter((a): a is ApprovalView => !!a && a.decision === null)
}

export function endedCalls(s: Pick<ConsoleState, 'calls' | 'callOrder'>): CallView[] {
  return s.callOrder
    .map((sid) => s.calls[sid])
    .filter((c): c is CallView => !!c && c.ended_at !== null)
    .reverse()
}

export function latestAnchor(anchors: ConsoleState['anchors']) {
  const sub = anchors.submitted.at(-1) ?? null
  if (!sub) return null
  const conf = anchors.confirmed.findLast((c) => c.head_seq >= sub.head_seq) ?? null
  return { submitted: sub, confirmed: conf }
}
