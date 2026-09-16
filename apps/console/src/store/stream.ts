import { create } from 'zustand'
import { LogEntry } from '@sentinel/shared'
import type { LogEntry as Entry } from '@sentinel/shared'
import { emptyState, fold, type ConsoleState } from './fold'

export type ChainStatus = {
  ok: boolean
  checked: number
  head_seq: number
  head_hash: string
  broken_at?: number
  checked_at: string
}

export type ServerState = {
  approval_on: boolean
  drill_on: boolean
  mode: 'drill' | 'live'
  operator_required: boolean
}

export type DrawerName = 'sitrep' | 'scout' | 'models' | 'chain' | 'operator'

type Store = {
  view: ConsoleState
  conn: 'connecting' | 'live' | 'retrying'
  chain: ChainStatus | null
  chainError: string | null
  server: ServerState | null
  unreadable: number
  unlockOpen: boolean
  unlockReason: string | null
  drawer: DrawerName | null
  apply: (entries: Entry[]) => void
  setDrawer: (d: DrawerName | null) => void
}

export const useConsole = create<Store>((set) => ({
  view: emptyState(),
  conn: 'connecting',
  chain: null,
  chainError: null,
  server: null,
  unreadable: 0,
  unlockOpen: false,
  unlockReason: null,
  drawer: null,
  apply: (entries) =>
    set((st) => {
      let v = st.view
      for (const e of entries) v = fold(v, e)
      return v === st.view ? st : { view: v }
    }),
  setDrawer: (drawer) => set({ drawer }),
}))

// --- operator gate ---------------------------------------------------------

const PASS_KEY = 'sentinel.operator'
let pendingAction: (() => void) | null = null

export function operatorPasscode(): string | null {
  try {
    return sessionStorage.getItem(PASS_KEY)
  } catch {
    return null
  }
}

function askForPasscode(reason: string, retry: () => void) {
  pendingAction = retry
  useConsole.setState({ unlockOpen: true, unlockReason: reason })
}

export function submitPasscode(pass: string) {
  try {
    sessionStorage.setItem(PASS_KEY, pass)
  } catch {
    // private mode: the passcode just won't survive a reload
  }
  useConsole.setState({ unlockOpen: false, unlockReason: null })
  const next = pendingAction
  pendingAction = null
  next?.()
}

export function cancelUnlock() {
  pendingAction = null
  useConsole.setState({ unlockOpen: false, unlockReason: null })
}

export function lockOperator() {
  try {
    sessionStorage.removeItem(PASS_KEY)
  } catch {
    // nothing stored
  }
}

export type OperatorResult = { ok: true; data: unknown } | { ok: false; message: string } | null

// null means we're waiting on the passcode dialog; the action re-runs once it's entered
export async function operatorPost(path: string, body: unknown, onDone?: (r: OperatorResult) => void): Promise<OperatorResult> {
  const run = () => void operatorPost(path, body, onDone)
  const pass = operatorPasscode()
  if (!pass) {
    askForPasscode('Operator passcode needed for this action.', run)
    return null
  }
  let res: Response
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-operator': pass },
      body: JSON.stringify(body),
    })
  } catch {
    const r = { ok: false as const, message: 'Could not reach the server.' }
    onDone?.(r)
    return r
  }
  if (res.status === 401) {
    lockOperator()
    askForPasscode('That passcode was not accepted. Try again.', run)
    return null
  }
  const data = await res.json().catch(() => null)
  const r: OperatorResult = res.ok
    ? { ok: true, data }
    : { ok: false, message: (data as { error?: string } | null)?.error ?? `Server said ${res.status}` }
  onDone?.(r)
  return r
}

// --- stream ----------------------------------------------------------------

let source: EventSource | null = null
let buffer: Entry[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let verifyTimer: ReturnType<typeof setTimeout> | null = null
let retryDelay = 1000

function flush() {
  flushTimer = null
  if (!buffer.length) return
  const batch = buffer
  buffer = []
  useConsole.getState().apply(batch)
  if (batch.some((e) => e.kind === 'anchor.submitted' || e.kind === 'anchor.confirmed')) scheduleVerify(1500)
}

function onMessage(msg: MessageEvent<string>) {
  let raw: unknown
  try {
    raw = JSON.parse(msg.data)
  } catch {
    useConsole.setState((s) => ({ unreadable: s.unreadable + 1 }))
    return
  }
  const parsed = LogEntry.safeParse(raw)
  if (!parsed.success) {
    useConsole.setState((s) => ({ unreadable: s.unreadable + 1 }))
    return
  }
  buffer.push(parsed.data as Entry)
  // replays arrive in bursts; one render per burst is plenty
  if (!flushTimer) flushTimer = setTimeout(flush, 40)
}

function connect() {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  source?.close()
  const after = useConsole.getState().view.head
  const es = new EventSource(`/api/stream?after=${after}`)
  source = es
  useConsole.setState({ conn: 'connecting' })
  es.onopen = () => {
    retryDelay = 1000
    useConsole.setState({ conn: 'live' })
    scheduleVerify(300)
  }
  es.onmessage = onMessage
  es.onerror = () => {
    useConsole.setState({ conn: 'retrying' })
    // CONNECTING means the browser is already retrying with Last-Event-ID; CLOSED means we must
    if (es.readyState === EventSource.CLOSED) {
      flush()
      retryTimer = setTimeout(connect, retryDelay)
      retryDelay = Math.min(retryDelay * 2, 15000)
    }
  }
}

async function verifyChain() {
  verifyTimer = null
  try {
    const res = await fetch('/api/log/verify')
    if (!res.ok) throw new Error(`verify returned ${res.status}`)
    const body = (await res.json()) as Omit<ChainStatus, 'checked_at'>
    useConsole.setState({ chain: { ...body, checked_at: new Date().toISOString() }, chainError: null })
  } catch (err) {
    useConsole.setState({ chainError: err instanceof Error ? err.message : 'verify failed' })
  }
}

function scheduleVerify(delay: number) {
  if (verifyTimer) clearTimeout(verifyTimer)
  verifyTimer = setTimeout(verifyChain, delay)
}

export async function refreshServerState() {
  try {
    const res = await fetch('/api/state')
    if (res.ok) useConsole.setState({ server: (await res.json()) as ServerState })
  } catch {
    // the stream status already tells the operator the server is unreachable
  }
}

export function startConsole(): () => void {
  void refreshServerState()
  connect()
  const poll = setInterval(() => scheduleVerify(0), 20000)
  return () => {
    clearInterval(poll)
    source?.close()
    source = null
    for (const t of [flushTimer, retryTimer, verifyTimer]) if (t) clearTimeout(t)
  }
}
