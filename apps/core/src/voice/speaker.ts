import type { Speak } from './deepgram.ts'

// Twilio moves 20 ms of 8 kHz mu-law per frame: 160 bytes.
const FRAME = 160
const FRAMES_PER_SEC = 50

export interface Wire {
  media(payload: string): void
  clear(): void
  // a copy of what we play, for the console's listen-in
  tap?(payload: string): void
}

/**
 * Plays our sentences to the caller, one after another, and stops the moment they talk over us.
 * Frames go out as fast as the socket takes them; Twilio buffers and plays at the right rate, and
 * `clear` empties that buffer when we need to stop. So "speaking" is about when the audio we've
 * handed over will finish playing, not whether we're still sending.
 */
export class Speaker {
  private speak: Speak
  private wire: Wire
  private queue: Promise<void> = Promise.resolve()
  private abort = new AbortController()
  private playUntil = 0
  private generation = 0

  constructor(speak: Speak, wire: Wire) {
    this.speak = speak
    this.wire = wire
  }

  get speaking(): boolean {
    return Date.now() < this.playUntil
  }

  // when everything queued so far will have finished playing
  async drained(): Promise<void> {
    await this.queue
    const left = this.playUntil - Date.now()
    if (left > 0) await new Promise((r) => setTimeout(r, left))
  }

  // Queue a sentence behind whatever is already playing.
  then(text: string): Promise<void> {
    if (!text.trim()) return this.queue
    const gen = this.generation
    this.queue = this.queue.then(() => (gen === this.generation ? this.pump(text, gen) : undefined)).catch(() => {})
    return this.queue
  }

  // Cut off: drop the queue, stop fetching audio, and flush Twilio's buffer.
  stop() {
    this.generation++
    this.abort.abort()
    this.abort = new AbortController()
    this.queue = Promise.resolve()
    this.playUntil = 0
    this.wire.clear()
  }

  private async pump(text: string, gen: number) {
    const signal = this.abort.signal
    const started = Math.max(Date.now(), this.playUntil)
    let sent = 0
    let carry = Buffer.alloc(0)
    const out = (frame: Buffer) => {
      const payload = frame.toString('base64')
      this.wire.media(payload)
      this.wire.tap?.(payload)
      sent++
      this.playUntil = started + (sent * 1000) / FRAMES_PER_SEC
    }
    try {
      for await (const chunk of await this.speak(text, signal)) {
        if (gen !== this.generation) return
        carry = carry.length ? Buffer.concat([carry, Buffer.from(chunk)]) : Buffer.from(chunk)
        while (carry.length >= FRAME) {
          out(carry.subarray(0, FRAME))
          carry = carry.subarray(FRAME)
        }
      }
      if (carry.length && gen === this.generation) out(carry)
    } catch {
      // a cut-off or a failed synth is survivable; the next sentence still gets its turn
    }
  }
}
