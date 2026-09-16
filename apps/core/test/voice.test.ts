import { afterEach, describe, expect, it } from 'vitest'
import type { WebSocket } from 'ws'
import type { StreamPart } from '../src/llm/chain.ts'
import { takeSentence } from '../src/voice/turn.ts'
import type { Telephony } from '../src/voice/twilio.ts'
import { relayTwiml } from '../src/voice/twiml.ts'
import { SAFE_LINE } from '../src/facts/verifier.ts'
import { PASS, makeApp } from './helpers.ts'

const NUMBER = '+15715550100'
const NURSE = '+15715550111'
const src = { name: 'FEMA Hospitals RAPT', retrieved_at: '2026-09-16T00:00:00Z', method: 'dataset' as const }

type Script = (userText: string) => StreamPart[]

function fakes(script: Script = () => [{ type: 'text', text: 'Okay.' }]) {
  const placed: { to: string; twiml: string }[] = []
  const telephony: Telephony = {
    async createCall(o) {
      placed.push(o)
      return { sid: `CA${String(placed.length).padStart(32, '0')}` }
    },
    async hangup() {},
    validate: () => true,
    voiceToken: () => 'token',
    fetchRecording: async () => new Response('audio'),
  }
  async function* llm(req: { messages: { role: string; content?: unknown }[] }) {
    const last = [...req.messages].reverse().find((m) => m.role === 'user')
    for (const p of script(String(last?.content ?? ''))) yield p
    yield { type: 'done', provider: 'fake', model: 'fake', ms: 1, firstTokenMs: 1 } as StreamPart
  }
  return { placed, telephony, llm: llm as never }
}

type App = Awaited<ReturnType<typeof makeApp>>
let current: App | null = null
afterEach(async () => {
  await current?.app.close()
  current = null
})

async function setup(script?: Script, extra: Record<string, string> = {}) {
  const f = fakes(script)
  current = await makeApp(extra, { telephony: f.telephony, llm: f.llm, env: { TWILIO_NUMBER: NUMBER } })
  await current.app.ready()
  return { ...current, ...f }
}

const kinds = (a: App) => a.chain.after(0, 1000).map((e) => e.kind)

function collect(ws: WebSocket) {
  const got: Record<string, any>[] = []
  ws.on('message', (raw: Buffer) => got.push(JSON.parse(String(raw))))
  return got
}

const until = async (check: () => boolean, ms = 2000) => {
  const t = Date.now()
  while (!check()) {
    if (Date.now() - t > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function answer(a: Awaited<ReturnType<typeof setup>>, sid: string) {
  const ref = /name="callRef" value="([^"]+)"/.exec(a.placed.at(-1)!.twiml)![1]!
  const ws = await a.app.injectWS('/voice/relay')
  const got = collect(ws)
  ws.send(JSON.stringify({ type: 'setup', callSid: sid, customParameters: { callRef: ref } }))
  return { ws, got }
}

describe('outbound calls', () => {
  it('refuses numbers not whitelisted', async () => {
    const a = await setup()
    await a.app.inject({ method: 'POST', url: '/api/switch/approval', headers: { 'x-operator': PASS }, payload: { on: false } })
    await a.app.inject({ method: 'POST', url: '/api/calls/test', headers: { 'x-operator': PASS }, payload: { role: 'charge_nurse' } })
    await until(() => kinds(a).includes('error'))
    expect(a.placed).toHaveLength(0)
  })

  it('waits for approval before dialling', async () => {
    const a = await setup()
    a.voice.whitelist.add(NURSE, 'Team phone', 'charge_nurse', 'test')
    await a.app.inject({ method: 'POST', url: '/api/calls/test', headers: { 'x-operator': PASS }, payload: { role: 'charge_nurse' } })
    expect(a.placed).toHaveLength(0)
    const req = a.chain.after(0, 100).find((e) => e.kind === 'approval.requested')!
    const id = (req.payload as { approval_id: string }).approval_id
    const res = await a.app.inject({ method: 'POST', url: `/api/approvals/${id}`, headers: { 'x-operator': PASS }, payload: { decision: 'approved' } })
    expect(res.statusCode).toBe(200)
    await until(() => a.placed.length === 1)
    expect(a.placed[0]!.to).toBe(NURSE)
    expect(a.placed[0]!.twiml).toContain('<ConversationRelay')
    expect(a.placed[0]!.twiml).toContain('drill pre-notification')
  })

  it('dials one call at a time', async () => {
    const a = await setup()
    a.voice.whitelist.add(NURSE, 'Team phone', 'charge_nurse', 'test')
    a.voice.whitelist.add('+15715550122', 'Team phone two', 'lifeline_county', 'test')
    await a.app.inject({ method: 'POST', url: '/api/switch/approval', headers: { 'x-operator': PASS }, payload: { on: false } })
    a.voice.queue.enqueue({ role: 'charge_nurse', runId: null, partyLabel: 'Nurse', reason: 't' })
    a.voice.queue.enqueue({ role: 'lifeline_county', runId: null, partyLabel: 'County', reason: 't' })
    await until(() => a.placed.length === 1)
    await new Promise((r) => setTimeout(r, 30))
    expect(a.placed).toHaveLength(1)
    await a.app.inject({
      method: 'POST',
      url: '/voice/status',
      payload: 'CallSid=CA00000000000000000000000000000001&CallStatus=completed&CallDuration=12',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    await until(() => a.placed.length === 2)
  })
})

describe('relay conversation', () => {
  async function onCall(script: Script) {
    const a = await setup(script)
    a.voice.whitelist.add(NURSE, 'Team phone', 'charge_nurse', 'test')
    const beds = a.facts.add('run-1', { key: 'hospital.inova.beds', label: 'Inova Alexandria staffed beds', value: 312, unit: 'beds', source: src })
    await a.app.inject({ method: 'POST', url: '/api/switch/approval', headers: { 'x-operator': PASS }, payload: { on: false } })
    a.voice.queue.enqueue({
      role: 'charge_nurse',
      runId: 'run-1',
      partyLabel: 'Inova charge desk',
      reason: 't',
      headlineKeys: ['hospital.inova.beds'],
    })
    await until(() => a.placed.length === 1)
    const call = await answer(a, 'CA00000000000000000000000000000001')
    return { a, beds, ...call }
  }

  it('opens with verified headline facts', async () => {
    const { a, got } = await onCall(() => [])
    await until(() => got.some((m) => m.type === 'text' && m.last === true))
    const said = got.filter((m) => m.type === 'text').map((m) => m.token).join('')
    expect(said).toContain('Inova Alexandria staffed beds: 312.')
    expect(kinds(a)).toContain('call.started')
  })

  it('speaks cited facts from the model', async () => {
    const { ws, got } = await onCall(() => [{ type: 'text', text: 'You have {F1} staffed beds. Anything else?' }])
    ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'how many beds do we have', last: true }))
    await until(() => got.filter((m) => m.last === true).length >= 2)
    const tokens = got.filter((m) => m.type === 'text').map((m) => m.token)
    expect(tokens).toContain('You have 312 staffed beds. ')
  })

  it('swaps out an unverified number', async () => {
    const { a, ws, got } = await onCall(() => [{ type: 'text', text: 'You have 450 beds. ' }])
    ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'how many beds', last: true }))
    await until(() => got.some((m) => m.token === `${SAFE_LINE} `))
    expect(kinds(a)).toContain('verify.block')
  })

  it('hands off on red flags', async () => {
    const { a, ws, got } = await onCall(() => [{ type: 'text', text: 'should never be said' }])
    ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'my father has chest pain', last: true }))
    await until(() => got.some((m) => m.type === 'end'))
    expect(JSON.parse(got.find((m) => m.type === 'end')!.handoffData)).toMatchObject({ reason: 'handoff' })
    expect(kinds(a)).toContain('call.handoff')
    expect(got.some((m) => String(m.token ?? '').includes('should never'))).toBe(false)
  })

  it('records the acknowledgement', async () => {
    const { a, ws, got } = await onCall((text) =>
      text.includes('acknowledged')
        ? [
            { type: 'tool_call', id: 't1', name: 'acknowledge', arguments: '{}' },
            { type: 'tool_call', id: 't2', name: 'end_call', arguments: '{}' },
          ]
        : [{ type: 'text', text: 'Thank you. ' }],
    )
    ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'acknowledged', last: true }))
    await until(() => got.some((m) => m.type === 'end'))
    const ledger = a.chain.after(0, 200).filter((e) => e.kind === 'ledger').map((e) => (e.payload as { milestone: string }).milestone)
    expect(ledger).toContain('acknowledged')
  })
})

describe('inbound line', () => {
  const form = (sid: string, from: string) => ({
    method: 'POST' as const,
    url: '/voice/inbound',
    payload: `CallSid=${sid}&From=${encodeURIComponent(from)}&To=${encodeURIComponent(NUMBER)}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })

  it('answers with the relay', async () => {
    const a = await setup()
    const res = await a.app.inject(form('CAin1', '+15715550199'))
    expect(res.headers['content-type']).toContain('text/xml')
    expect(res.body).toContain('drill line')
  })

  it('gives a busy line', async () => {
    const a = await setup()
    await a.app.inject(form('CAin1', '+15715550199'))
    const second = await a.app.inject(form('CAin2', '+15715550198'))
    expect(second.body).toContain('on another call')
    expect(kinds(a)).toContain('call.busy')
  })

  it('rejects unsigned webhooks', async () => {
    const f = fakes()
    current = await makeApp({}, { telephony: { ...f.telephony, validate: () => false }, env: { TWILIO_NUMBER: NUMBER } })
    const res = await current.app.inject(form('CAx', '+15715550199'))
    expect(res.statusCode).toBe(403)
  })
})

describe('whitelist', () => {
  it('needs the consent box', async () => {
    const a = await setup()
    const res = await a.app.inject({
      method: 'POST',
      url: '/api/whitelist',
      headers: { 'x-operator': PASS },
      payload: { number: NURSE, label: 'Judge', role: 'charge_nurse' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('never lists hospital numbers', async () => {
    const a = await setup()
    a.sqlite
      .prepare("INSERT INTO hospitals (ccn, name, phone_main, updated_at) VALUES ('490040', 'Inova Alexandria', '(703) 504-3000', 'now')")
      .run()
    expect(() => a.voice.whitelist.add('7035043000', 'oops', 'charge_nurse', 'test')).toThrow(/hospital/)
  })

  it('accepts the console softphone', async () => {
    const a = await setup()
    expect(a.voice.whitelist.add('client:console', 'Console tab', 'charge_nurse', 'test')).toBe('client:console')
    expect(a.voice.whitelist.has('client:console')).toBe(true)
  })

  it('logs numbers masked', async () => {
    const a = await setup()
    a.voice.whitelist.add(NURSE, 'Team phone', 'charge_nurse', 'test')
    const entry = a.chain.after(0).find((e) => e.kind === 'whitelist.changed')!
    expect(JSON.stringify(entry)).not.toContain('5550111')
  })
})

describe('helpers', () => {
  it('splits sentences sensibly', () => {
    expect(takeSentence('Head to St. Mary. Then')).toEqual(['Head to St. Mary.', ' Then'])
    expect(takeSentence('About 3.5 hours')).toBeNull()
  })

  it('escapes the greeting', () => {
    const x = relayTwiml({ base: 'https://h', callRef: 'r', greeting: 'Tom & "Jerry" <x>', record: false, listen: false })
    expect(x).toContain('Tom &amp; &quot;Jerry&quot; &lt;x&gt;')
  })
})
