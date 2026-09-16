import { randomUUID } from 'node:crypto'
import type { CallRole } from '@sentinel/shared'

// What we know about a call before Twilio connects the relay socket.
export interface CallContext {
  callRef: string
  callId?: string
  role: CallRole
  direction: 'in' | 'out'
  runId: string | null
  partyLabel: string
  test: boolean
  // facts the opening turn reads out, by key
  headlineKeys: string[]
  hospitalLabel?: string
  zip?: string
  createdAt: number
}

export interface CallSession extends CallContext {
  callSid: string
  startedAt: number
  ackAt?: number
  lastHeard: string
  endAfterTurn: boolean
  handoffReason?: string
  ended: boolean
}

// One line, one call. The registry is the only place that knows whether the line is busy.
export class CallRegistry {
  private contexts = new Map<string, CallContext>()
  private sessions = new Map<string, CallSession>()
  // an outbound call that has been dialled but hasn't connected yet still holds the line
  private dialling = new Map<string, string>() // callSid -> callRef
  readonly limit: number

  constructor(limit = 1) {
    this.limit = limit
  }

  prepare(ctx: Omit<CallContext, 'callRef' | 'createdAt'>): CallContext {
    const full = { ...ctx, callRef: randomUUID(), createdAt: Date.now() }
    this.contexts.set(full.callRef, full)
    return full
  }

  context(callRef: string) {
    return this.contexts.get(callRef)
  }

  markDialling(callSid: string, callRef: string) {
    this.dialling.set(callSid, callRef)
  }

  busy(): boolean {
    const live = [...this.sessions.values()].filter((s) => !s.ended).length
    return live + this.dialling.size >= this.limit
  }

  open(callRef: string, callSid: string): CallSession | null {
    const ctx = this.contexts.get(callRef)
    if (!ctx) return null
    const existing = this.sessions.get(callSid)
    if (existing && !existing.ended) return existing
    this.dialling.delete(callSid)
    const s: CallSession = { ...ctx, callSid, startedAt: Date.now(), lastHeard: '', endAfterTurn: false, ended: false }
    this.sessions.set(callSid, s)
    return s
  }

  session(callSid: string) {
    return this.sessions.get(callSid)
  }

  active(): CallSession | undefined {
    return [...this.sessions.values()].find((s) => !s.ended)
  }

  // call is over for good (status callback said so)
  finish(callSid: string): CallSession | undefined {
    this.dialling.delete(callSid)
    const s = this.sessions.get(callSid)
    if (s) {
      s.ended = true
      this.contexts.delete(s.callRef)
    }
    return s
  }
}
