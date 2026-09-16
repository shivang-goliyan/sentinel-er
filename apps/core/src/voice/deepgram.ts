import WebSocket from 'ws'

// Deepgram in both directions, both in Twilio's own format (8 kHz mu-law), so nothing is resampled.

export interface ListenOptions {
  endpointingMs: number
  utteranceEndMs: number
}

export interface Listener {
  send(audio: Buffer): void
  close(): void
  on(event: 'message', fn: (msg: DeepgramMessage) => void): void
  on(event: 'close', fn: () => void): void
}

export type DeepgramMessage =
  | { type: 'Results'; is_final?: boolean; speech_final?: boolean; channel?: { alternatives?: { transcript?: string }[] } }
  | { type: 'SpeechStarted' }
  | { type: 'UtteranceEnd' }
  | { type: 'Metadata' }

export type OpenListener = (opts: ListenOptions) => Listener
export type Speak = (text: string, signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>

export function deepgramListener(key: string): OpenListener {
  return (opts) => {
    const qs = new URLSearchParams({
      model: 'nova-3',
      encoding: 'mulaw',
      sample_rate: '8000',
      channels: '1',
      punctuate: 'true',
      smart_format: 'true',
      interim_results: 'true',
      // a turn ends on speech_final; this is the silence that asks the question
      endpointing: String(opts.endpointingMs),
      // the net for callers who trail off into noise instead of silence
      utterance_end_ms: String(opts.utteranceEndMs),
      vad_events: 'true',
    })
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${qs}`, { headers: { authorization: `Token ${key}` } })
    const pending: Buffer[] = []
    ws.on('open', () => {
      for (const b of pending.splice(0)) ws.send(b)
    })
    // Deepgram drops idle sockets; a keepalive every few seconds holds it through long replies
    const keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }))
    }, 5_000)
    ws.on('close', () => clearInterval(keepalive))
    ws.on('error', () => {})
    return {
      send(audio) {
        if (ws.readyState === WebSocket.OPEN) ws.send(audio)
        else if (ws.readyState === WebSocket.CONNECTING && pending.length < 250) pending.push(audio)
      },
      close() {
        clearInterval(keepalive)
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }))
        ws.close()
      },
      on(event: 'message' | 'close', fn: (m: DeepgramMessage) => void) {
        if (event === 'close') ws.on('close', () => (fn as () => void)())
        else ws.on('message', (raw: Buffer) => {
          try {
            fn(JSON.parse(String(raw)) as DeepgramMessage)
          } catch {
            // not JSON, not ours
          }
        })
      },
    } as Listener
  }
}

export function deepgramSpeaker(key: string, model: string): Speak {
  return async (text, signal) => {
    const qs = new URLSearchParams({ model, encoding: 'mulaw', sample_rate: '8000', container: 'none' })
    const res = await fetch(`https://api.deepgram.com/v1/speak?${qs}`, {
      method: 'POST',
      signal,
      headers: { authorization: `Token ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    if (!res.ok || !res.body) throw new Error(`Deepgram speak said ${res.status}`)
    // read as it arrives: waiting for the whole clip costs seconds before the first syllable
    return res.body as unknown as AsyncIterable<Uint8Array>
  }
}
