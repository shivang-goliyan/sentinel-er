import type { WebSocket } from 'ws'
import type { Deps } from '../server.ts'
import { maskPhone } from '@sentinel/shared'
import { Speaker } from './speaker.ts'
import { Conversation } from './turn.ts'
import { TurnTaker } from './turns.ts'
import { dialTwiml, sayAndHangup } from './twiml.ts'

// Measured on the operator's own receptionist: a turn fires on speech_final, so the silence window
// can be short without cutting people off mid-thought.
const ENDPOINTING_MS = Number(process.env.VOICE_ENDPOINT_MS ?? 350)
const UTTERANCE_END_MS = Number(process.env.VOICE_UTTERANCE_END_MS ?? 1000)

type TwilioEvent =
  | { event: 'connected' }
  | { event: 'start'; streamSid: string; start: { callSid: string; streamSid: string; customParameters?: Record<string, string> } }
  | { event: 'media'; streamSid: string; media: { track?: string; payload: string } }
  | { event: 'mark'; streamSid: string }
  | { event: 'stop'; streamSid: string }

// One Twilio media stream = one call: caller audio in, our speech out, Deepgram in between.
export function handleMediaStream(socket: WebSocket, deps: Deps) {
  const { voice, chain, sqlite, facts } = deps
  let streamSid = ''
  let callSid = ''
  let convo: Conversation | null = null
  let turns: TurnTaker | null = null
  let speaker: Speaker | null = null
  let ears: ReturnType<NonNullable<typeof voice.openListener>> | null = null
  let finishing = false

  const send = (m: object) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(m))
  }
  const tap = (track: string, payload: string | null) => {
    if (!voice.listeners.size) return
    // a null payload means "drop what you've queued", same as Twilio's clear
    const out = JSON.stringify(payload === null ? { callSid, track, clear: true } : { callSid, track, payload })
    for (const l of voice.listeners) if (l.readyState === 1) l.send(out)
  }

  const finish = async (kind: 'done' | 'handoff') => {
    if (finishing || !speaker) return
    finishing = true
    await speaker.drained()
    const tel = voice.telephony
    if (!tel || !callSid) return
    try {
      if (kind === 'handoff') {
        // still whitelist-only: the person taking red-flag calls has to be on the list
        const human = voice.whitelist.numberFor('handoff')
        await tel.update(
          callSid,
          human
            ? dialTwiml(human.e164, 'Connecting you to a person now.')
            : sayAndHangup('If this is an emergency, hang up and dial 9 1 1 now. Goodbye.'),
        )
      } else {
        await tel.hangup(callSid)
      }
    } catch (err) {
      chain.append('comms', 'error', { where: 'ending the call', message: (err as Error).message }, convoRun())
    }
  }
  const convoRun = () => (callSid ? voice.registry.session(callSid)?.runId ?? null : null)

  socket.on('message', (raw: Buffer) => {
    let ev: TwilioEvent
    try {
      ev = JSON.parse(String(raw)) as TwilioEvent
    } catch {
      return
    }

    if (ev.event === 'start') {
      streamSid = ev.streamSid || ev.start.streamSid
      callSid = ev.start.callSid
      const ref = ev.start.customParameters?.callRef ?? ''
      const s = voice.registry.open(ref, callSid)
      if (!s || !voice.openListener || !voice.speak) {
        chain.append('comms', 'error', { where: 'voice line', message: s ? 'Deepgram is not configured' : 'a stream arrived for a call we did not set up' }, null)
        socket.close()
        return
      }
      sqlite.prepare("UPDATE calls SET status = 'in-progress' WHERE sid = ?").run(callSid)
      chain.append(
        'comms',
        'call.started',
        { call_sid: callSid, call_id: s.callId, role: s.role, direction: s.direction, party_label: s.partyLabel, test: s.test },
        s.runId,
      )

      speaker = new Speaker(voice.speak, {
        media: (payload) => send({ event: 'media', streamSid, media: { payload } }),
        clear: () => {
          send({ event: 'clear', streamSid })
          tap('outbound', null)
        },
        tap: (payload) => tap('outbound', payload),
      })
      const spk = speaker
      convo = new Conversation({
        session: s,
        facts,
        chain,
        callbackNumber: voice.settings.from,
        llm: voice.llm,
        port: {
          say: (text) => void spk.then(text),
          finish: (kind) => void finish(kind),
        },
        onAcknowledged: (sess) => {
          sqlite.prepare('UPDATE calls SET ack_at = ? WHERE sid = ?').run(new Date().toISOString(), sess.callSid)
          if (sess.runId && sess.role === 'charge_nurse') chain.append('orchestrator', 'ledger', { milestone: 'acknowledged' }, sess.runId)
        },
        onNumberRecorded: (sess, number) => {
          chain.append('scout', 'status', { text: `${sess.partyLabel} gave a charge-line number (${maskPhone(number)})`, state: 'done' }, sess.runId)
        },
      })
      voice.conversations.set(callSid, convo)
      const c = convo
      turns = new TurnTaker({
        turn: (text) => void c.heard(text),
        interrupt: () => spk.stop(),
        speaking: () => spk.speaking,
      })
      const t = turns
      ears = voice.openListener({ endpointingMs: ENDPOINTING_MS, utteranceEndMs: UTTERANCE_END_MS })
      ears.on('message', (m) => t.feed(m))
      void convo.start()
      return
    }

    if (ev.event === 'media') {
      if (!ears) return
      const audio = Buffer.from(ev.media.payload, 'base64')
      ears.send(audio)
      tap('inbound', ev.media.payload)
      return
    }

    if (ev.event === 'stop') socket.close()
  })

  socket.on('close', () => {
    turns?.close()
    ears?.close()
    convo?.close()
    if (callSid) voice.conversations.delete(callSid)
  })
}
