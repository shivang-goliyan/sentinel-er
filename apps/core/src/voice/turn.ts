import type { Fact } from '@sentinel/shared'
import { verify } from '../facts/verifier.ts'
import { stream as llmStream, type Message, type StreamPart } from '../llm/chain.ts'
import type { LogChain } from '../log/chain.ts'
import type { FactStore } from '../facts/store.ts'
import { EMERGENCY_LINE, redFlag } from './redflags.ts'
import { ROLES, factSheet, type RoleContext } from './roles.ts'
import type { CallSession } from './sessions.ts'

export type RelayOut =
  | { type: 'text'; token: string; last: boolean }
  | { type: 'end'; handoffData: string }

export type LlmStream = typeof llmStream

export interface ConversationDeps {
  session: CallSession
  facts: FactStore
  chain: LogChain
  send: (msg: RelayOut) => void
  callbackNumber: string
  llm?: LlmStream
  onAcknowledged?: (s: CallSession) => void
  onNumberRecorded?: (s: CallSession, number: string) => void
}

const MAX_TOOL_ROUNDS = 3
const ABBREVIATION = /\b(?:Dr|St|Mt|Rd|Ave|Blvd|Hwy|Ft|Mr|Mrs|Ms|No|Jr|Sr|approx|vs|etc|e\.g|i\.e|U\.S)\.$/i

// Returns the first complete sentence and what's left, or null if we should wait for more text.
export function takeSentence(buf: string): [string, string] | null {
  for (let i = 0; i < buf.length; i++) {
    const ch = buf[i]
    if (ch !== '.' && ch !== '!' && ch !== '?') continue
    const next = buf[i + 1]
    if (next === undefined) return null
    if (!/\s/.test(next)) continue
    const head = buf.slice(0, i + 1)
    if (ch === '.' && ABBREVIATION.test(head)) continue
    return [head.trim(), buf.slice(i + 1)]
  }
  return null
}

export class Conversation {
  private history: Message[] = []
  private abort: AbortController | null = null
  private busy: Promise<void> = Promise.resolve()
  private d: ConversationDeps
  private llm: LlmStream

  constructor(deps: ConversationDeps) {
    this.d = deps
    this.llm = deps.llm ?? llmStream
  }

  private get s() {
    return this.d.session
  }

  private get role() {
    return ROLES[this.s.role]
  }

  private ctx(): RoleContext {
    return { session: this.s, facts: this.d.facts, chain: this.d.chain, callbackNumber: this.d.callbackNumber }
  }

  private runFacts(): Fact[] {
    const base = this.s.runId ? this.d.facts.all(this.s.runId) : []
    // the callback number is said on fixed lines; it isn't a run fact but it is verified
    const callback: Fact = {
      id: 'Fcallback',
      run_id: this.s.runId ?? 'system',
      key: 'system.callback_number',
      label: 'Callback number',
      value: this.d.callbackNumber,
      unit: 'text',
      display: this.d.callbackNumber,
      spoken: this.d.callbackNumber,
      tolerance: {},
      source: { name: 'Sentinel ER configuration', retrieved_at: new Date(0).toISOString(), method: 'operator' },
      supersedes: null,
      created_at: new Date(0).toISOString(),
    }
    return [...base, callback]
  }

  private log<K extends 'call.heard' | 'call.said' | 'call.tool' | 'call.handoff'>(kind: K, payload: Record<string, unknown>) {
    this.d.chain.append('comms', kind, { call_sid: this.s.callSid, ...payload } as never, this.s.runId)
  }

  // Everything we say goes through here.
  private say(text: string) {
    const v = verify(text, this.runFacts(), 'voice')
    if (v.verdict === 'block') {
      this.d.chain.append(
        'verifier',
        'verify.block',
        { channel: 'voice', target: this.s.callSid, text, findings: v.findings },
        this.s.runId,
      )
    }
    this.d.send({ type: 'text', token: `${v.rendered} `, last: false })
    this.log('call.said', { text: v.rendered, verdict: v.verdict, fact_ids: v.factIds })
    return v.rendered
  }

  private finishTurn() {
    this.d.send({ type: 'text', token: '', last: true })
    if (this.s.handoffReason) {
      this.d.send({ type: 'end', handoffData: JSON.stringify({ reason: 'handoff', detail: this.s.handoffReason }) })
    } else if (this.s.endAfterTurn) {
      this.d.send({ type: 'end', handoffData: JSON.stringify({ reason: 'done' }) })
    }
  }

  // queue turns so a fast talker can't interleave two replies
  private enqueue(fn: () => Promise<void>) {
    this.busy = this.busy.then(fn, fn).catch((err) => {
      this.d.chain.append('comms', 'error', { where: 'voice turn', message: String(err?.message ?? err) }, this.s.runId)
      this.say("Sorry, I'm having trouble right now. The console has the verified figures.")
      this.finishTurn()
    })
    return this.busy
  }

  start() {
    const opening = this.role.opening(this.ctx())
    if (!opening) return Promise.resolve()
    return this.enqueue(async () => {
      const said = this.say(opening)
      this.history.push({ role: 'assistant', content: said })
      this.finishTurn()
    })
  }

  heard(text: string) {
    this.abort?.abort(new Error('caller spoke'))
    this.s.lastHeard = text
    this.log('call.heard', { text })
    return this.enqueue(() => this.reply(text))
  }

  interrupted(spokenSoFar: string) {
    this.abort?.abort(new Error('interrupted'))
    const last = this.history.at(-1)
    if (last?.role === 'assistant' && typeof last.content === 'string' && spokenSoFar) {
      last.content = spokenSoFar
    }
  }

  close() {
    this.abort?.abort(new Error('call closed'))
  }

  private async reply(text: string) {
    const flag = redFlag(text)
    if (flag) {
      this.s.handoffReason = `caller said "${flag}"`
      this.log('call.handoff', { reason: this.s.handoffReason })
      this.say(EMERGENCY_LINE)
      this.finishTurn()
      return
    }

    this.history.push({ role: 'user', content: text })
    const ctrl = new AbortController()
    this.abort = ctrl

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const sheet = factSheet(this.s.runId ? this.d.facts.latest(this.s.runId) : [], this.role.factPrefixes)
      const messages: Message[] = [{ role: 'system', content: this.role.system(this.ctx(), sheet) }, ...this.history]
      let pending = ''
      let raw = ''
      const calls: Extract<StreamPart, { type: 'tool_call' }>[] = []

      for await (const part of this.llm({ lane: 'voice', messages, tools: this.role.tools, signal: ctrl.signal, maxTokens: 300 })) {
        if (part.type === 'text') {
          pending += part.text
          for (let cut = takeSentence(pending); cut; cut = takeSentence(pending)) {
            this.say(cut[0])
            raw += `${cut[0]} `
            pending = cut[1]
          }
        } else if (part.type === 'tool_call') {
          calls.push(part)
        }
      }
      if (ctrl.signal.aborted) return
      if (pending.trim()) {
        this.say(pending.trim())
        raw += pending.trim()
      }

      this.history.push({
        role: 'assistant',
        content: raw.trim() || null,
        ...(calls.length
          ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } })) }
          : {}),
      } as Message)
      if (!calls.length) break

      for (const c of calls) {
        const result = this.runTool(c.name, c.arguments)
        this.history.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) })
      }
      if (this.s.handoffReason) break
    }
    this.finishTurn()
  }

  private runTool(name: string, rawArgs: string): unknown {
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(rawArgs || '{}')
    } catch {
      return { error: 'arguments were not valid JSON' }
    }
    const summary = (s: string) => this.log('call.tool', { tool: name, summary: s })
    const runId = this.s.runId

    switch (name) {
      case 'get_fact': {
        const q = String(args.query ?? '').toLowerCase()
        const words = q.split(/\s+/).filter(Boolean)
        const found = (runId ? this.d.facts.latest(runId) : [])
          .filter((f) => words.every((w) => `${f.label} ${f.key}`.toLowerCase().includes(w)))
          .slice(0, 8)
          .map((f) => ({ id: f.id, label: f.label, value: f.display }))
        summary(`looked up "${q}", ${found.length} found`)
        return { facts: found, cite_as: 'write {id} in your reply, e.g. {F3}' }
      }
      case 'acknowledge': {
        if (!this.s.ackAt) {
          this.s.ackAt = Date.now()
          this.d.onAcknowledged?.(this.s)
        }
        summary('acknowledged')
        return { ok: true }
      }
      case 'end_call': {
        this.s.endAfterTurn = true
        summary('ending the call')
        return { ok: true }
      }
      case 'handoff_to_human': {
        this.s.handoffReason = String(args.reason ?? 'caller asked for a person')
        this.log('call.handoff', { reason: this.s.handoffReason })
        return { ok: true }
      }
      case 'record_number': {
        const said = String(args.number ?? '')
        const digits = said.replace(/\D/g, '')
        // only keep it if the person really said those digits
        const heard = this.s.lastHeard.replace(/\D/g, '')
        const ok = digits.length >= 7 && heard.includes(digits)
        summary(ok ? 'charge line recorded' : 'number not heard verbatim, not recorded')
        if (ok) this.d.onNumberRecorded?.(this.s, said)
        return { recorded: ok }
      }
      default:
        return { error: `no tool called ${name}` }
    }
  }
}
