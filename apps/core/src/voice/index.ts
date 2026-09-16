import type { WebSocket } from 'ws'
import type { Deps } from '../server.ts'
import { OutboundQueue, type VoiceSettings } from './outbound.ts'
import { CallRegistry } from './sessions.ts'
import type { Conversation, LlmStream } from './turn.ts'
import { twilioTelephony, type Telephony } from './twilio.ts'
import { Whitelist } from './whitelist.ts'

export interface VoiceOverrides {
  telephony?: Telephony | null
  llm?: LlmStream
  env?: NodeJS.ProcessEnv
}

export type Voice = ReturnType<typeof createVoice>

export function createVoice(deps: Omit<Deps, 'voice' | 'requireOperator'>, o: VoiceOverrides = {}) {
  const env = o.env ?? process.env
  const telephony = o.telephony !== undefined ? o.telephony : twilioTelephony(env)
  const registry = new CallRegistry(1)
  const whitelist = new Whitelist(deps.sqlite, deps.chain)
  const secret = env.VOICE_WEBHOOK_SECRET
  const settings: VoiceSettings = {
    base: deps.config.PUBLIC_BASE_URL.replace(/\/$/, ''),
    from: env.TWILIO_NUMBER ?? '',
    record: deps.config.VOICE_RECORD,
    listen: deps.config.VOICE_LISTEN,
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
    conversations: new Map<string, Conversation>(),
    // the relay socket for each call; replaced if Twilio reconnects the call
    sockets: new Map<string, WebSocket>(),
    listeners: new Set<WebSocket>(),
  }
}
