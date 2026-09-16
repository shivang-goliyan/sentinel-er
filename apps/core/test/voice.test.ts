import { afterEach, describe, expect, it } from 'vitest'
import type { WebSocket } from 'ws'
import type { StreamPart } from '../src/llm/chain.ts'
import type { DeepgramMessage, Listener, OpenListener, Speak } from '../src/voice/deepgram.ts'
import { Speaker } from '../src/voice/speaker.ts'
import { takeSentence } from '../src/voice/turn.ts'
import { TurnTaker, isBackchannel } from '../src/voice/turns.ts'
import type { Telephony } from '../src/voice/twilio.ts'
import { streamTwiml } from '../src/voice/twiml.ts'
import { SAFE_LINE } from '../src/facts/verifier.ts'
import { PASS, makeApp } from './helpers.ts'

const NUMBER = '+15715550100'
const NURSE = '+15715550111'
const src = { name: 'FEMA Hospitals RAPT', retrieved_at: '2026-09-16T00:00:00Z', method: 'dataset' as const }

type Script = (userText: string) => StreamPart[]

const bytes = (n: number) =>
  (async function* () {
    yield new Uint8Array(n)
  })()

function fakes(script: Script = () => [{ type: 'text', text: 'Okay.' }]) {
  const placed: { to: string; twiml: string }[] = []
  const updates: { sid: string; twiml: string }[] = []
  const hungUp: string[] = []
  const telephony: Telephony = {
    async createCall(o) {
      placed.push(o)
      return { sid: `CA${String(placed.length).padStart(32, '0')}` }
    },
    async hangup(sid) {
      hungUp.push(sid)
    },
    async update(sid, twiml) {
      updates.push({ sid, twiml })
    },
    validate: () => true,
    voiceToken: () => 'token',
    fetchRecording: async () => new Response('audio'),
  }
  async function* llm(req: { messages: { role: string; content?: unknown }[] }) {
    const last = [...req.messages].reverse().find((m) => m.role === 'user')
    for (const p of script(String(last?.content ?? ''))) yield p
    yield { type: 'done', provider: 'fake', model: 'fake', ms: 1, firstTokenMs: 1 } as StreamPart
  }

  // Deepgram, both directions
  const spoken: string[] = []
  const heardAudio: Buffer[] = []
  let emit: (m: DeepgramMessage) => void = () => {}
  const openListener: OpenListener = () =>
    ({
      send: (b: Buffer) => heardAudio.push(b),
      close: () => {},
      on: (event: string, fn: (m: DeepgramMessage) => void) => {
        if (event === 'message') emit = fn
      },
    }) as Listener
  const speak: Speak = async (text) => {
    spoken.push(text)
    return bytes(400)
  }

  return {
    placed,
    updates,
    hungUp,
    spoken,
    heardAudio,
    hears: (m: DeepgramMessage) => emit(m),
    overrides: { telephony, llm: llm as never, openListener, speak, env: { TWILIO_NUMBER: NUMBER } },
  }
}

type App = Awaited<ReturnType<typeof makeApp>>
let current: App | null = null
afterEach(async () => {
  await current?.app.close()
  current = null
})

async function setup(script?: Script) {
  const f = fakes(script)
  current = await makeApp({}, f.overrides)
  await current.app.ready()
  return { ...current, ...f }
}

const kinds = (a: App) => a.chain.after(0, 1000).map((e) => e.kind)

const until = async (check: () => boolean, ms = 2000) => {
  const t = Date.now()
  while (!check()) {
    if (Date.now() - t > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const final = (transcript: string, speechFinal = true): DeepgramMessage => ({
  type: 'Results',
  is_final: true,
  speech_final: speechFinal,
  channel: { alternatives: [{ transcript }] },
})

const approvalsOff = (a: App) =>
  a.app.inject({ method: 'POST', url: '/api/switch/approval', headers: { 'x-operator': PASS }, payload: { on: false } })

async function answer(a: Awaited<ReturnType<typeof setup>>, sid: string) {
  const ref = /name="callRef" value="([^"]+)"/.exec(a.placed.at(-1)!.twiml)![1]!
  const ws = (await a.app.injectWS('/voice/media')) as unknown as WebSocket
  const got: Record<string, any>[] = []
  ws.on('message', (raw: Buffer) => got.push(JSON.parse(String(raw))))
  ws.send(JSON.stringify({ event: 'connected' }))
  ws.send(
    JSON.stringify({ event: 'start', streamSid: 'MZ1', start: { callSid: sid, streamSid: 'MZ1', customParameters: { callRef: ref } } }),
  )
  return { ws, got }
}

describe('outbound calls', () => {
  it('refuses numbers not whitelisted', async () => {
    const a = await setup()
    await approvalsOff(a)
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
    const res = await a.app.inject({
      method: 'POST',
      url: `/api/approvals/${id}`,
      headers: { 'x-operator': PASS },
      payload: { decision: 'approved' },
    })
    expect(res.statusCode).toBe(200)
    await until(() => a.placed.length === 1)
    expect(a.placed[0]!.to).toBe(NURSE)
    expect(a.placed[0]!.twiml).toContain('<Connect><Stream url="ws://')
  })

  it('dials one call at a time', async () => {
    const a = await setup()
    a.voice.whitelist.add(NURSE, 'Team phone', 'charge_nurse', 'test')
    a.voice.whitelist.add('+15715550122', 'Team phone two', 'lifeline_county', 'test')
    await approvalsOff(a)
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

describe('media stream call', () => {
  async function onCall(script: Script) {
    const a = await setup(script)
    a.voice.whitelist.add(NURSE, 'Team phone', 'charge_nurse', 'test')
    a.facts.add('run-1', { key: 'hospital.inova.beds', label: 'Inova Alexandria staffed beds', value: 312, unit: 'beds', source: src })
    await approvalsOff(a)
    a.voice.queue.enqueue({
      role: 'charge_nurse',
      runId: 'run-1',
      partyLabel: 'Inova charge desk',
      reason: 't',
      headlineKeys: ['hospital.inova.beds'],
    })
    await until(() => a.placed.length === 1)
    const call = await answer(a, 'CA00000000000000000000000000000001')
    // greeting and headline opening
    await until(() => a.spoken.length >= 2)
    return { a, ...call }
  }

  it('greets then reads verified headlines', async () => {
    const { a, got } = await onCall(() => [])
    expect(a.spoken[0]).toContain('drill pre-notification')
    expect(a.spoken[1]).toContain('Inova Alexandria staffed beds: 312.')
    await until(() => got.some((m) => m.event === 'media'))
    const frame = got.find((m) => m.event === 'media')!
    expect(frame.streamSid).toBe('MZ1')
    expect(Buffer.from(frame.media.payload, 'base64').length).toBe(160)
    expect(kinds(a)).toContain('call.started')
  })

  it('passes caller audio to Deepgram', async () => {
    const { a, ws } = await onCall(() => [])
    ws.send(JSON.stringify({ event: 'media', streamSid: 'MZ1', media: { track: 'inbound', payload: Buffer.alloc(160, 1).toString('base64') } }))
    await until(() => a.heardAudio.length === 1)
    expect(a.heardAudio[0]!.length).toBe(160)
  })

  it('speaks cited facts from the model', async () => {
    const { a } = await onCall(() => [{ type: 'text', text: 'You have {F1} staffed beds right now. Anything else?' }])
    a.hears(final('How many staffed beds do we have in the building?'))
    await until(() => a.spoken.includes('You have 312 staffed beds right now.'))
    expect(a.spoken).toContain('Anything else?')
  })

  it('swaps out an unverified number', async () => {
    const { a } = await onCall(() => [{ type: 'text', text: 'You have 450 beds. ' }])
    a.hears(final('How many staffed beds do we have in the building?'))
    await until(() => a.spoken.includes(SAFE_LINE))
    expect(kinds(a)).toContain('verify.block')
  })

  it('stops talking when interrupted', async () => {
    const { a, got } = await onCall(() => [])
    a.hears({ type: 'SpeechStarted' })
    await until(() => got.some((m) => m.event === 'clear'))
  })

  it('hands red flags to a person', async () => {
    const { a } = await onCall(() => [{ type: 'text', text: 'should never be said' }])
    a.voice.whitelist.add('+15715550199', 'Duty officer', 'handoff', 'test')
    a.hears(final('My father has chest pain and is sweating a lot.'))
    await until(() => a.updates.length === 1)
    expect(a.updates[0]!.twiml).toContain('<Dial')
    expect(kinds(a)).toContain('call.handoff')
    expect(a.spoken.some((t) => t.includes('should never'))).toBe(false)
  })

  it('records the acknowledgement and hangs up', async () => {
    const { a } = await onCall((text) =>
      text.includes('acknowledged')
        ? [
            { type: 'tool_call', id: 't1', name: 'acknowledge', arguments: '{}' },
            { type: 'tool_call', id: 't2', name: 'end_call', arguments: '{}' },
          ]
        : [{ type: 'text', text: 'Thank you. ' }],
    )
    a.hears(final('Yes, that is all acknowledged on our side, thank you.'))
    await until(() => a.hungUp.length === 1)
    const ledger = a.chain
      .after(0, 200)
      .filter((e) => e.kind === 'ledger')
      .map((e) => (e.payload as { milestone: string }).milestone)
    expect(ledger).toContain('acknowledged')
  })

  it('closes streams nobody set up', async () => {
    const a = await setup()
    const ws = (await a.app.injectWS('/voice/media')) as unknown as WebSocket
    const closed = new Promise((r) => ws.on('close', r))
    ws.send(JSON.stringify({ event: 'start', streamSid: 'MZ9', start: { callSid: 'CAx', streamSid: 'MZ9', customParameters: { callRef: 'nope' } } }))
    await closed
    expect(kinds(a)).toContain('error')
  })
})

describe('turn taking', () => {
  const taker = (speaking = true) => {
    const turns: string[] = []
    let cuts = 0
    const t = new TurnTaker(
      { turn: (x) => turns.push(x), interrupt: () => cuts++, speaking: () => speaking },
      { continuationMs: 40, shortTurnWords: 8 },
    )
    return { t, turns, cuts: () => cuts }
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('answers finished long sentences', () => {
    const { t, turns } = taker()
    t.feed(final('We have a question about the arrivals expected tonight.'))
    expect(turns).toEqual(['We have a question about the arrivals expected tonight.'])
  })

  it('waits on short fragments', async () => {
    const { t, turns } = taker()
    t.feed(final('How many'))
    expect(turns).toHaveLength(0)
    t.feed(final('are coming to us?'))
    await wait(60)
    expect(turns).toEqual(['How many are coming to us?'])
  })

  it('ignores backchannels', async () => {
    const { t, turns } = taker()
    t.feed(final('Okay.'))
    await wait(60)
    expect(turns).toHaveLength(0)
    expect(isBackchannel('Mm-hm.')).toBe(true)
    expect(isBackchannel('okay which one')).toBe(false)
  })

  it('flushes on utterance end', () => {
    const { t, turns } = taker()
    t.feed(final('we are on the second floor', false))
    t.feed({ type: 'UtteranceEnd' })
    expect(turns).toEqual(['we are on the second floor'])
  })

  it('cuts in on voice activity', () => {
    const { t, cuts } = taker()
    t.feed({ type: 'SpeechStarted' })
    expect(cuts()).toBe(1)
  })

  it('cuts in on interim words', () => {
    const { t, cuts } = taker()
    t.feed({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'wait which hospital' }] } })
    t.feed({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'yeah' }] } })
    expect(cuts()).toBe(1)
    const quiet = taker(false)
    quiet.t.feed({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'wait which hospital' }] } })
    expect(quiet.cuts()).toBe(0)
  })
})

describe('speaker', () => {
  const wire = () => {
    const frames: string[] = []
    let clears = 0
    return { frames, clears: () => clears, media: (p: string) => frames.push(p), clear: () => void clears++ }
  }

  it('frames audio for Twilio', async () => {
    const w = wire()
    const s = new Speaker(async () => bytes(350), w)
    await s.then('hello there')
    expect(w.frames.map((f) => Buffer.from(f, 'base64').length)).toEqual([160, 160, 30])
    expect(s.speaking).toBe(true)
    await s.drained()
    expect(s.speaking).toBe(false)
  })

  it('plays sentences in order', async () => {
    const said: string[] = []
    const s = new Speaker(async (text) => {
      said.push(text)
      return bytes(160)
    }, wire())
    void s.then('one')
    void s.then('two')
    await s.then('three')
    expect(said).toEqual(['one', 'two', 'three'])
  })

  it('drops the queue when stopped', async () => {
    const said: string[] = []
    const w = wire()
    let release = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const s = new Speaker(async (text) => {
      said.push(text)
      if (text === 'one') await gate
      return bytes(160)
    }, w)
    void s.then('one')
    void s.then('two')
    await new Promise((r) => setTimeout(r, 10))
    s.stop()
    release()
    await new Promise((r) => setTimeout(r, 20))
    expect(said).toEqual(['one'])
    expect(w.frames).toHaveLength(0)
    expect(w.clears()).toBe(1)
    expect(s.speaking).toBe(false)
  })

  it('survives a failed synth', async () => {
    const w = wire()
    const s = new Speaker(async (text) => {
      if (text === 'bad') throw new Error('nope')
      return bytes(160)
    }, w)
    void s.then('bad')
    await s.then('good')
    expect(w.frames).toHaveLength(1)
  })
})

describe('inbound line', () => {
  const form = (sid: string, from: string) => ({
    method: 'POST' as const,
    url: '/voice/inbound',
    payload: `CallSid=${sid}&From=${encodeURIComponent(from)}&To=${encodeURIComponent(NUMBER)}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })

  it('answers with a media stream', async () => {
    const a = await setup()
    const res = await a.app.inject(form('CAin1', '+15715550199'))
    expect(res.headers['content-type']).toContain('text/xml')
    expect(res.body).toContain('/voice/media')
    expect(res.body).toContain('name="callRef"')
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
    current = await makeApp({}, { ...f.overrides, telephony: { ...f.overrides.telephony, validate: () => false } })
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

  it('escapes stream parameters', () => {
    const x = streamTwiml({ base: 'https://h', callRef: 'a"b<c', record: false })
    expect(x).toContain('value="a&quot;b&lt;c"')
    expect(x).toContain('url="wss://h/voice/media"')
    expect(x).not.toContain('<Recording')
  })

  it('records both channels when asked', () => {
    const x = streamTwiml({ base: 'https://h', callRef: 'r', record: true, webhookQuery: 'k=s' })
    expect(x).toContain('<Start><Recording channels="dual"')
    expect(x).toContain('/voice/recording?k=s')
  })
})
