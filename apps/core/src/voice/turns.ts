import type { DeepgramMessage } from './deepgram.ts'

// Silence alone is a poor end-of-turn signal: people pause mid-sentence. Deepgram's speech_final
// asks the question and punctuation answers it. A finished, long-enough sentence is answered at
// once; anything else waits a moment for the rest.
export interface TurnOptions {
  continuationMs: number
  shortTurnWords: number
}

export const TURN_DEFAULTS: TurnOptions = { continuationMs: 500, shortTurnWords: 8 }

const BACKCHANNELS = new Set([
  'mm', 'mhm', 'mm hm', 'uh huh', 'yeah', 'yes', 'yep', 'ok', 'okay', 'right', 'sure', 'got it', 'i see', 'alright', 'go on',
])

export function isBackchannel(text: string): boolean {
  const clean = text.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
  return BACKCHANNELS.has(clean)
}

export interface TurnEvents {
  // the caller has finished a turn
  turn(text: string): void
  // they started talking; stop playing
  interrupt(): void
  // are we currently playing audio?
  speaking(): boolean
}

export class TurnTaker {
  private parts: string[] = []
  private hold: ReturnType<typeof setTimeout> | null = null
  private opts: TurnOptions
  private ev: TurnEvents

  constructor(ev: TurnEvents, opts: TurnOptions = TURN_DEFAULTS) {
    this.ev = ev
    this.opts = opts
  }

  private flush() {
    if (this.hold) clearTimeout(this.hold)
    this.hold = null
    const text = this.parts.join(' ').trim()
    this.parts = []
    if (text && !isBackchannel(text)) this.ev.turn(text)
  }

  private endOfTurn() {
    if (this.hold) clearTimeout(this.hold)
    const whole = this.parts.join(' ').trim()
    const finished = /[.!?]$/.test(whole)
    const long = whole.split(/\s+/).length >= this.opts.shortTurnWords
    if (finished && long) this.flush()
    else this.hold = setTimeout(() => this.flush(), this.opts.continuationMs)
  }

  feed(m: DeepgramMessage) {
    if (m.type === 'UtteranceEnd') return this.flush()
    // voice energy, before any words: stopping here is what a person does
    if (m.type === 'SpeechStarted') return this.ev.interrupt()
    if (m.type !== 'Results') return
    const text = (m.channel?.alternatives?.[0]?.transcript ?? '').trim()
    if (!text) return
    if (!m.is_final) {
      // backstop for when voice activity events aren't arriving
      if (this.ev.speaking() && !isBackchannel(text)) this.ev.interrupt()
      return
    }
    // they carried on inside the hold window: the turn simply grows
    if (this.hold) {
      clearTimeout(this.hold)
      this.hold = null
    }
    this.parts.push(text)
    if (m.speech_final) this.endOfTurn()
  }

  close() {
    if (this.hold) clearTimeout(this.hold)
  }
}
