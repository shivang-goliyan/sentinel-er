import { create } from 'zustand'
import { operatorPasscode } from '../store/stream'

// Plays Twilio's copy of the live call (8 kHz μ-law, both sides) through this tab, so a
// presented Meet tab carries it to the room.
export const useListen = create<{ on: boolean; message: string | null }>(() => ({ on: false, message: null }))

let ws: WebSocket | null = null
let ctx: AudioContext | null = null
const nextAt: Record<string, number> = {}

const ULAW = new Float32Array(256)
for (let i = 0; i < 256; i++) {
  const b = ~i & 0xff
  const sign = b & 0x80
  const exponent = (b >> 4) & 0x07
  const mantissa = b & 0x0f
  const sample = (((mantissa << 3) + 0x84) << exponent) - 0x84
  ULAW[i] = (sign ? -sample : sample) / 32768
}

function play(trackName: string, base64: string) {
  if (!ctx) return
  const bin = atob(base64)
  const samples = new Float32Array(bin.length)
  for (let i = 0; i < bin.length; i++) samples[i] = ULAW[bin.charCodeAt(i)]!
  const buf = ctx.createBuffer(1, samples.length, 8000)
  buf.copyToChannel(samples, 0)
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.connect(ctx.destination)
  // a small cushion keeps the two sides from stuttering
  const at = Math.max(nextAt[trackName] ?? 0, ctx.currentTime + 0.12)
  src.start(at)
  nextAt[trackName] = at + buf.duration
}

export function startListening() {
  const pass = operatorPasscode()
  if (!pass) {
    useListen.setState({ message: 'Unlock the operator controls first.' })
    return
  }
  ctx = new AudioContext()
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(`${proto}//${location.host}/api/listen?op=${encodeURIComponent(pass)}`)
  ws.onopen = () => useListen.setState({ on: true, message: 'Listening. Audio plays when a call is live.' })
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as { track?: string; payload?: string }
    if (m.payload) play(m.track ?? 'mix', m.payload)
  }
  ws.onclose = () => {
    useListen.setState({ on: false })
    void ctx?.close()
    ctx = null
  }
}

export function stopListening() {
  ws?.close()
  ws = null
  for (const k of Object.keys(nextAt)) delete nextAt[k]
  useListen.setState({ on: false, message: null })
}
