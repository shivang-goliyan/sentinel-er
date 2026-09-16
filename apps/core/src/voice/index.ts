import type { WebSocket } from 'ws'
import type { Deps } from '../server.ts'
import { OutboundQueue, type VoiceSettings } from './outbound.ts'
import { CallRegistry } from './sessions.ts'
import type { Conversation, LlmStream } from './turn.ts'
import { deepgramListener, deepgramSpeaker, type OpenListener, type Speak } from './deepgram.ts'
import { twilioTelephony, type Telephony } from './twilio.ts'
import { Whitelist } from './whitelist.ts'

export interface VoiceOverrides {
  telephony?: Telephony | null
  llm?: LlmStream
  env?: NodeJS.ProcessEnv
  openListener?: OpenListener | null
  speak?: Speak | null
}

export type Voice = ReturnType<typeof createVoice>

export function createVoice(deps: Omit<Deps, 'voice' | 'requireOperator'>, o: VoiceOverrides = {}) {
  const env = o.env ?? process.env
  const telephony = o.telephony !== undefined ? o.telephony : twilioTelephony(env)
  const registry = new CallRegistry(1)
  const whitelist = new Whitelist(deps.sqlite, deps.chain)
  const secret = env.VOICE_WEBHOOK_SECRET
  const dg = env.DEEPGRAM_API_KEY
  const settings: VoiceSettings = {
    base: deps.config.PUBLIC_BASE_URL.replace(/\/$/, ''),
    from: env.TWILIO_NUMBER ?? '',
    record: deps.config.VOICE_RECORD,
    webhookQuery: env.TWILIO_AUTH_TOKEN || !secret ? undefined : `k=${encodeURIComponent(secret)}`,
  }
  const queue = new OutboundQueue({
    sqlite: deps.sqlite,
    chain: deps.chain,
    switches: deps.switches,
    registry,
    whitelist,
    telephony,
    settings,
  })
  return {
    telephony,
    registry,
    whitelist,
    settings,
    queue,
    llm: o.llm,
    openListener: o.openListener !== undefined ? o.openListener : dg ? deepgramListener(dg) : null,
    speak: o.speak !== undefined ? o.speak : dg ? deepgramSpeaker(dg, env.VOICE_TTS_MODEL ?? 'aura-2-thalia-en') : null,
    conversations: new Map<string, Conversation>(),
    listeners: new Set<WebSocket>(),
  }
}
