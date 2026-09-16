import formbody from '@fastify/formbody'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { maskPhone } from '@sentinel/shared'
import { z } from 'zod'
import type { Deps } from '../server.ts'
import { handleMediaStream } from '../voice/media.ts'
import { sayAndHangup, streamTwiml } from '../voice/twiml.ts'
import { WHITELIST_ROLES, type WhitelistRole } from '../voice/whitelist.ts'

const TERMINAL = new Set(['completed', 'busy', 'failed', 'no-answer', 'canceled'])
const BUSY_LINE = 'The Sentinel E R drill line is on another call right now. Please call back in a minute.'

type Form = Record<string, string>

export async function registerVoice(app: FastifyInstance, deps: Deps) {
  const { chain, voice, requireOperator, sqlite, activeRun } = deps
  const { registry, queue, whitelist, telephony, settings } = voice

  await app.register(formbody)

  // audio elements and websockets can't send headers, so the passcode may come as ?op=
  const operatorFromQuery = async (req: FastifyRequest, reply: FastifyReply) => {
    const op = (req.query as Record<string, string> | undefined)?.op
    if (op && !req.headers['x-operator']) req.headers['x-operator'] = op
    return requireOperator(req, reply)
  }

  const fromTwilio = (req: FastifyRequest) =>
    telephony?.validate(
      req.headers['x-twilio-signature'] as string | undefined,
      `${settings.base}${req.url}`,
      (req.body as Form) ?? {},
      (req.query as Form) ?? {},
    ) ?? false

  const twiml = (reply: FastifyReply, body: string) => reply.type('text/xml').send(body)
  const now = () => new Date().toISOString()

  // ---- Twilio webhooks ----

  app.post('/voice/inbound', async (req, reply) => {
    if (!fromTwilio(req)) return reply.code(403).send('forbidden')
    const p = req.body as Form
    const from = p.From ?? ''
    const test = from.startsWith('client:')
    const label = test ? 'Console test call' : `Caller ${maskPhone(from)}`
    if (registry.busy()) {
      chain.append('comms', 'call.busy', { from_label: label }, activeRun.current)
      return twiml(reply, sayAndHangup(BUSY_LINE))
    }
    const ctx = registry.prepare({
      role: 'public',
      direction: 'in',
      runId: activeRun.current,
      partyLabel: label,
      test,
      headlineKeys: [],
    })
    registry.markDialling(p.CallSid!, ctx.callRef)
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO calls (sid, run_id, direction, role, party_label, from_masked, status, started_at, test)
         VALUES (?, ?, 'in', 'public', ?, ?, 'ringing', ?, ?)`,
      )
      .run(p.CallSid, ctx.runId, label, test ? 'console' : maskPhone(from), now(), test ? 1 : 0)
    return twiml(
      reply,
      streamTwiml({ base: settings.base, callRef: ctx.callRef, record: settings.record, webhookQuery: settings.webhookQuery }),
    )
  })

  app.post('/voice/status', async (req, reply) => {
    if (!fromTwilio(req)) return reply.code(403).send('forbidden')
    const p = req.body as Form
    const sid = p.CallSid ?? ''
    const status = p.CallStatus ?? 'unknown'
    sqlite.prepare('UPDATE calls SET status = ? WHERE sid = ?').run(status, sid)
    if (TERMINAL.has(status)) {
      const s = registry.finish(sid)
      voice.conversations.get(sid)?.close()
      voice.conversations.delete(sid)
      sqlite
        .prepare('UPDATE calls SET ended_at = ?, ack_at = ? WHERE sid = ?')
        .run(now(), s?.ackAt ? new Date(s.ackAt).toISOString() : null, sid)
      const runId = s?.runId ?? (sqlite.prepare<[string], { run_id: string | null }>('SELECT run_id FROM calls WHERE sid = ?').get(sid)?.run_id ?? null)
      chain.append(
        'comms',
        'call.ended',
        { call_sid: sid, status, duration_s: Number(p.CallDuration ?? 0), acknowledged: Boolean(s?.ackAt) },
        runId,
      )
      void queue.pump()
    }
    return reply.code(204).send()
  })

  app.post('/voice/recording', async (req, reply) => {
    if (!fromTwilio(req)) return reply.code(403).send('forbidden')
    const p = req.body as Form
    if (p.RecordingStatus === 'completed' && p.RecordingSid) {
      const url = `/api/recordings/${p.RecordingSid}`
      sqlite.prepare('UPDATE calls SET recording_url = ? WHERE sid = ?').run(url, p.CallSid)
      const runId = sqlite.prepare<[string], { run_id: string | null }>('SELECT run_id FROM calls WHERE sid = ?').get(p.CallSid ?? '')?.run_id ?? null
      chain.append('comms', 'artifact', { type: 'recording', name: `call-${p.CallSid}.mp3`, url, call_sid: p.CallSid }, runId)
    }
    return reply.code(204).send()
  })

  // ---- the call's audio ----

  app.get('/voice/media', { websocket: true }, (socket) => handleMediaStream(socket, deps))

  app.get('/api/listen', { websocket: true, preHandler: operatorFromQuery }, (socket) => {
    voice.listeners.add(socket)
    socket.on('close', () => voice.listeners.delete(socket))
  })

  // ---- operator ----

  app.get('/api/voice/state', async () => {
    const active = registry.active()
    return {
      configured: Boolean(telephony && settings.from),
      number: settings.from ? maskPhone(settings.from) : null,
      busy: registry.busy(),
      active: active ? { call_sid: active.callSid, role: active.role, party_label: active.partyLabel } : null,
      queue: queue.list(),
      record: settings.record,
      listen: true,
      speech: Boolean(voice.openListener && voice.speak),
    }
  })

  const TestCall = z.object({ role: z.enum(['charge_nurse', 'lifeline_county', 'lifeline_dme', 'switchboard']) })
  app.post('/api/calls/test', { preHandler: requireOperator }, async (req, reply) => {
    const body = TestCall.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'Pick a role: charge_nurse, lifeline_county, lifeline_dme or switchboard.' })
    const role = body.data.role
    const callId = queue.enqueue({
      role,
      runId: activeRun.current,
      partyLabel: `Test call: ${role.replace('_', ' ')}`,
      reason: 'operator test call',
      test: true,
    })
    return { call_id: callId }
  })

  app.post<{ Params: { sid: string } }>('/api/calls/:sid/end', { preHandler: requireOperator }, async (req, reply) => {
    if (!telephony) return reply.code(409).send({ error: 'Twilio is not configured.' })
    await telephony.hangup(req.params.sid)
    return { ok: true }
  })

  const Decision = z.object({ decision: z.enum(['approved', 'declined']) })
  app.post<{ Params: { id: string } }>('/api/approvals/:id', { preHandler: requireOperator }, async (req, reply) => {
    const body = Decision.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'Send {"decision": "approved"} or {"decision": "declined"}.' })
    const ok = queue.decide(req.params.id, body.data.decision, 'operator')
    if (!ok) return reply.code(404).send({ error: 'No pending approval with that id.' })
    return { ok: true }
  })

  app.get('/api/whitelist', { preHandler: requireOperator }, async () => ({ entries: whitelist.list() }))

  const AddNumber = z.object({
    number: z.string().min(7),
    label: z.string().trim().min(1).max(80),
    role: z.enum(WHITELIST_ROLES),
    consent: z.literal(true),
  })
  app.post('/api/whitelist', { preHandler: requireOperator }, async (req, reply) => {
    const body = AddNumber.safeParse(req.body)
    if (!body.success) {
      return reply.code(400).send({ error: 'Need a number, a label, a role, and the consent box ticked.' })
    }
    try {
      whitelist.add(body.data.number, body.data.label, body.data.role as WhitelistRole, 'operator')
      return { ok: true }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.delete<{ Params: { number: string } }>('/api/whitelist/:number', { preHandler: requireOperator }, async (req, reply) => {
    return whitelist.remove(req.params.number) ? { ok: true } : reply.code(404).send({ error: 'Not on the list.' })
  })

  app.get('/api/voice/token', { preHandler: requireOperator }, async (_req, reply) => {
    if (!telephony) return reply.code(409).send({ error: 'Twilio is not configured.' })
    return { identity: 'console', token: telephony.voiceToken('console') }
  })

  app.get<{ Params: { sid: string } }>('/api/recordings/:sid', { preHandler: operatorFromQuery }, async (req, reply) => {
    if (!telephony) return reply.code(409).send({ error: 'Twilio is not configured.' })
    if (!/^RE[0-9a-f]{32}$/.test(req.params.sid)) return reply.code(400).send({ error: 'Not a recording id.' })
    const res = await telephony.fetchRecording(req.params.sid)
    if (!res.ok) return reply.code(res.status).send({ error: 'Twilio would not hand over that recording.' })
    return reply.type('audio/mpeg').send(Buffer.from(await res.arrayBuffer()))
  })
}
