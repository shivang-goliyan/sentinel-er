import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { maskPhone, type CallRole } from '@sentinel/shared'
import type { LogChain } from '../log/chain.ts'
import type { Switches } from '../switches.ts'
import type { CallRegistry } from './sessions.ts'
import type { Telephony } from './twilio.ts'
import { streamTwiml } from './twiml.ts'
import { NotWhitelisted, type Whitelist, type WhitelistRole } from './whitelist.ts'

export interface OutboundRequest {
  role: Exclude<CallRole, 'public'>
  runId: string | null
  partyLabel: string
  reason: string
  headlineKeys?: string[]
  hospitalLabel?: string
  zip?: string
  test?: boolean
}

interface Item extends OutboundRequest {
  callId: string
  approvalId: string | null
  approved: boolean
}

export interface VoiceSettings {
  base: string
  from: string
  record: boolean
  webhookQuery?: string
}

// Calls go out one at a time, in order, and only after a person says yes (when the switch is on).
export class OutboundQueue {
  private items: Item[] = []
  private placing = false
  private d: {
    sqlite: Database.Database
    chain: LogChain
    switches: Switches
    registry: CallRegistry
    whitelist: Whitelist
    telephony: Telephony | null
    settings: VoiceSettings
  }

  constructor(d: OutboundQueue['d']) {
    this.d = d
  }

  list() {
    return this.items.map(({ callId, role, partyLabel, approved, approvalId }) => ({ callId, role, partyLabel, approved, approvalId }))
  }

  enqueue(req: OutboundRequest): string {
    const { chain, switches, sqlite } = this.d
    const callId = randomUUID()
    const needsApproval = switches.approval
    const approvalId = needsApproval ? randomUUID() : null
    const item: Item = { ...req, callId, approvalId, approved: !needsApproval }
    this.items.push(item)
    chain.append('comms', 'call.queued', { call_id: callId, role: req.role, party_label: req.partyLabel }, req.runId)
    if (approvalId) {
      const action = { type: 'call' as const, role: req.role, party_label: req.partyLabel, reason: req.reason }
      sqlite
        .prepare('INSERT INTO approvals (id, run_id, action, requested_at) VALUES (?, ?, ?, ?)')
        .run(approvalId, req.runId, JSON.stringify({ ...action, call_id: callId }), new Date().toISOString())
      chain.append('orchestrator', 'approval.requested', { approval_id: approvalId, action }, req.runId)
    }
    void this.pump()
    return callId
  }

  decide(approvalId: string, decision: 'approved' | 'declined', by: string): boolean {
    const item = this.items.find((i) => i.approvalId === approvalId)
    const row = this.d.sqlite.prepare<[string], { decision: string | null }>('SELECT decision FROM approvals WHERE id = ?').get(approvalId)
    if (!item || !row || row.decision) return false
    this.d.sqlite
      .prepare('UPDATE approvals SET decision = ?, decided_at = ?, decided_by = ? WHERE id = ?')
      .run(decision, new Date().toISOString(), by, approvalId)
    this.d.chain.append('operator', 'approval.decided', { approval_id: approvalId, decision, by }, item.runId)
    if (decision === 'approved') {
      item.approved = true
      this.d.chain.append('orchestrator', 'ledger', { milestone: 'approved' }, item.runId)
    } else {
      this.items = this.items.filter((i) => i !== item)
    }
    void this.pump()
    return true
  }

  // called whenever the line frees up or something new is approved
  async pump() {
    if (this.placing || this.d.registry.busy()) return
    const next = this.items[0]
    if (!next || !next.approved) return
    this.items.shift()
    this.placing = true
    try {
      await this.placeCall(next)
    } catch (err) {
      this.d.chain.append('comms', 'error', { where: `calling ${next.partyLabel}`, message: (err as Error).message }, next.runId)
    } finally {
      this.placing = false
    }
    if (!this.d.registry.busy()) void this.pump()
  }

  // The only function in the codebase that dials a number.
  private async placeCall(item: Item) {
    const { telephony, whitelist, registry, settings, chain } = this.d
    if (!telephony) throw new Error('Twilio is not configured, so no call was placed.')
    const target = whitelist.numberFor(item.role as WhitelistRole)
    if (!target) throw new NotWhitelisted(`Nobody on the whitelist for ${item.role}. Add a consenting number first.`)
    if (!whitelist.has(target.e164)) throw new NotWhitelisted('Refusing to dial a number that is not whitelisted.')

    const ctx = registry.prepare({
      callId: item.callId,
      role: item.role,
      direction: 'out',
      runId: item.runId,
      partyLabel: item.partyLabel,
      test: Boolean(item.test),
      headlineKeys: item.headlineKeys ?? [],
      hospitalLabel: item.hospitalLabel,
      zip: item.zip,
    })
    const twiml = streamTwiml({
      base: settings.base,
      callRef: ctx.callRef,
      record: settings.record,
      webhookQuery: settings.webhookQuery,
    })
    const q = settings.webhookQuery ? `?${settings.webhookQuery}` : ''
    const { sid } = await telephony.createCall({
      to: target.e164,
      from: settings.from,
      twiml,
      statusCallback: `${settings.base}/voice/status${q}`,
    })
    registry.markDialling(sid, ctx.callRef)
    this.d.sqlite
      .prepare(
        `INSERT INTO calls (sid, run_id, direction, role, party_label, to_masked, from_masked, status, started_at, test)
         VALUES (?, ?, 'out', ?, ?, ?, ?, 'dialling', ?, ?)`,
      )
      .run(sid, item.runId, item.role, item.partyLabel, maskPhone(target.e164), maskPhone(settings.from), new Date().toISOString(), item.test ? 1 : 0)
    chain.append('orchestrator', 'ledger', { milestone: 'call_placed' }, item.runId)
  }
}
