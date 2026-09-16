import { z } from 'zod'
import { Actor, CallRole, HazardEvent, Milestone, RunMode } from './events.ts'
import { Fact, Finding, VerifyChannel } from './facts.ts'

const callBase = { call_sid: z.string() }

export const MAX_LAYER_BYTES = 400_000

// One entry per kind. The console folds these, so every screen state has to be derivable from them.
export const LogBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event.detected'), payload: z.object({ event: HazardEvent }) }),
  z.object({
    kind: z.literal('event.tiered'),
    payload: z.object({ event_id: z.string(), tier: z.number().int(), reason: z.string() }),
  }),
  z.object({
    kind: z.literal('run.started'),
    payload: z.object({
      event_id: z.string(),
      mode: RunMode,
      title: z.string(),
      as_of: z.string().nullable().default(null),
      detected_at: z.string(),
    }),
  }),
  z.object({
    kind: z.literal('run.ended'),
    payload: z.object({ status: z.enum(['done', 'stopped', 'failed', 'watch']), note: z.string().optional() }),
  }),
  z.object({
    kind: z.literal('status'),
    payload: z.object({
      text: z.string(),
      state: z.enum(['idle', 'working', 'done', 'blocked', 'error']).default('working'),
    }),
  }),
  z.object({ kind: z.literal('ledger'), payload: z.object({ milestone: Milestone }) }),
  z.object({ kind: z.literal('fact'), payload: z.object({ fact: Fact }) }),
  z.object({
    kind: z.literal('fetch'),
    payload: z.object({
      source: z.string(),
      url: z.string(),
      method: z.string().default('GET'),
      status: z.number().int(),
      bytes: z.number().int().default(0),
      ms: z.number().int().default(0),
      snippet: z.string().optional(),
      from_tape: z.boolean().default(false),
    }),
  }),
  z.object({
    kind: z.literal('model.output'),
    payload: z.object({ model: z.string(), version: z.string(), outputs: z.record(z.string(), z.unknown()) }),
  }),
  z.object({
    kind: z.literal('sitrep.draft'),
    payload: z.object({ attempt: z.number().int(), text: z.string() }),
  }),
  z.object({
    kind: z.literal('verify.pass'),
    payload: z.object({ channel: VerifyChannel, target: z.string(), findings: z.array(Finding).default([]) }),
  }),
  z.object({
    kind: z.literal('verify.block'),
    payload: z.object({
      channel: VerifyChannel,
      target: z.string(),
      text: z.string(),
      findings: z.array(Finding),
    }),
  }),
  z.object({
    kind: z.literal('sitrep.final'),
    payload: z.object({ text: z.string(), template: z.boolean(), fact_ids: z.array(z.string()) }),
  }),
  z.object({
    kind: z.literal('artifact'),
    payload: z.object({
      type: z.enum(['sitrep_pdf', 'drone_plan', 'recording', 'chart']),
      name: z.string(),
      call_sid: z.string().optional(),
      url: z.string(),
      bytes: z.number().int().optional(),
    }),
  }),
  z.object({
    kind: z.literal('approval.requested'),
    payload: z.object({
      approval_id: z.string(),
      action: z.object({ type: z.literal('call'), role: CallRole, party_label: z.string(), reason: z.string() }),
    }),
  }),
  z.object({
    kind: z.literal('approval.decided'),
    payload: z.object({ approval_id: z.string(), decision: z.enum(['approved', 'declined']), by: z.string() }),
  }),
  z.object({
    kind: z.literal('call.queued'),
    payload: z.object({ call_id: z.string(), role: CallRole, party_label: z.string() }),
  }),
  z.object({
    kind: z.literal('call.started'),
    payload: z.object({
      ...callBase,
      call_id: z.string().optional(),
      role: CallRole,
      direction: z.enum(['in', 'out']),
      party_label: z.string(),
      test: z.boolean().default(false),
    }),
  }),
  z.object({ kind: z.literal('call.heard'), payload: z.object({ ...callBase, text: z.string() }) }),
  z.object({
    kind: z.literal('call.said'),
    payload: z.object({
      ...callBase,
      text: z.string(),
      verdict: z.enum(['pass', 'pass_with_note', 'block']),
      fact_ids: z.array(z.string()).default([]),
    }),
  }),
  z.object({
    kind: z.literal('call.tool'),
    payload: z.object({ ...callBase, tool: z.string(), summary: z.string() }),
  }),
  z.object({ kind: z.literal('call.handoff'), payload: z.object({ ...callBase, reason: z.string() }) }),
  z.object({ kind: z.literal('call.busy'), payload: z.object({ from_label: z.string() }) }),
  z.object({
    kind: z.literal('call.ended'),
    payload: z.object({
      ...callBase,
      status: z.string(),
      duration_s: z.number().int().default(0),
      acknowledged: z.boolean().default(false),
    }),
  }),
  z.object({
    kind: z.literal('capacity.updated'),
    payload: z.object({ ccn: z.string(), reserved: z.number().int(), reason: z.string() }),
  }),
  z.object({
    kind: z.literal('anchor.submitted'),
    payload: z.object({ head_seq: z.number().int(), head_hash: z.string() }),
  }),
  z.object({
    kind: z.literal('anchor.confirmed'),
    payload: z.object({ head_seq: z.number().int(), block_height: z.number().int().nullable() }),
  }),
  z.object({
    kind: z.literal('fallback.used'),
    payload: z.object({ source: z.string(), url: z.string(), reason: z.string() }),
  }),
  z.object({
    kind: z.literal('fault.injected'),
    payload: z.object({ fault: z.string(), detail: z.string() }),
  }),
  z.object({
    kind: z.literal('switch.changed'),
    payload: z.object({ name: z.enum(['approval', 'drill']), on: z.boolean() }),
  }),
  z.object({
    kind: z.literal('whitelist.changed'),
    payload: z.object({ label: z.string(), role: z.string(), masked: z.string(), removed: z.boolean().default(false) }),
  }),
  // map data for the console; the orchestrator keeps each one under MAX_LAYER_BYTES
  z.object({
    kind: z.literal('layer'),
    payload: z.object({
      name: z.string(),
      title: z.string(),
      source: z.string(),
      geojson: z.object({ type: z.literal('FeatureCollection'), features: z.array(z.any()) }),
    }),
  }),
  z.object({ kind: z.literal('note'), payload: z.object({ text: z.string() }) }),
  z.object({ kind: z.literal('error'), payload: z.object({ where: z.string(), message: z.string() }) }),
])
export type LogBody = z.infer<typeof LogBody>
export type LogKind = LogBody['kind']
export type PayloadOf<K extends LogKind> = Extract<LogBody, { kind: K }>['payload']
// what callers pass in: defaults are applied by the schema
export type PayloadInput<K extends LogKind> = z.input<typeof LogBody> extends infer U
  ? U extends { kind: K; payload: infer P }
    ? P
    : never
  : never

const LogMeta = z.object({
  seq: z.number().int().positive(),
  ts: z.string(),
  run_id: z.string().nullable(),
  actor: Actor,
  prev_hash: z.string().length(64),
  hash: z.string().length(64),
})

export const LogEntry = z.intersection(LogMeta, LogBody)
export type LogEntry = z.infer<typeof LogMeta> & LogBody
