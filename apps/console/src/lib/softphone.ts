import { Call, Device } from '@twilio/voice-sdk'
import { create } from 'zustand'
import { operatorGet } from '../store/stream'

export type PhoneStatus = 'off' | 'starting' | 'ready' | 'ringing' | 'in-call' | 'error'

export const usePhone = create<{ status: PhoneStatus; message: string | null }>(() => ({ status: 'off', message: null }))

// Lives outside React so closing the drawer never drops a call.
let device: Device | null = null
let current: Call | null = null

const set = (status: PhoneStatus, message: string | null = null) => usePhone.setState({ status, message })

async function fetchToken(): Promise<string | null> {
  const r = await operatorGet('/api/voice/token')
  if (!r) return null
  if (!r.ok) {
    set('error', r.message)
    return null
  }
  return (r.data as { token: string }).token
}

function track(call: Call) {
  current = call
  call.on('accept', () => set('in-call'))
  const done = () => {
    current = null
    set(device ? 'ready' : 'off')
  }
  call.on('disconnect', done)
  call.on('cancel', done)
  call.on('reject', done)
  call.on('error', (e: { message?: string }) => set('error', e.message ?? 'Call error'))
}

export async function startPhone() {
  if (device) return
  set('starting')
  const token = await fetchToken()
  if (!token) {
    if (usePhone.getState().status === 'starting') set('off')
    return
  }
  const d = new Device(token, { codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU], closeProtection: true })
  d.on('registered', () => set('ready'))
  d.on('error', (e: { message?: string }) => set('error', e.message ?? 'Softphone error'))
  d.on('incoming', (call: Call) => {
    track(call)
    set('ringing')
  })
  d.on('tokenWillExpire', async () => {
    const t = await fetchToken()
    if (t) d.updateToken(t)
  })
  device = d
  try {
    await d.register()
  } catch (e) {
    set('error', (e as Error).message)
  }
}

export function answer() {
  current?.accept()
}

export function hangUp() {
  if (current) current.disconnect()
  else device?.disconnectAll()
}

// Rings our own public line from this tab, which tests the inbound path end to end.
export async function callPublicLine() {
  if (!device) return
  try {
    const call = await device.connect({ params: { To: 'sentinel-public-line' } })
    track(call)
    set('in-call')
  } catch (e) {
    set('error', (e as Error).message)
  }
}

export function stopPhone() {
  device?.destroy()
  device = null
  current = null
  set('off')
}
