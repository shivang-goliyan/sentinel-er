import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net'
import { join } from 'node:path'

// Node gives each connect attempt 250 ms before trying the next address family. Far-away
// government servers take longer than that to answer, and the connect fails outright.
setDefaultAutoSelectFamilyAttemptTimeout(2_000)

export type TapeMode = 'live' | 'record' | 'replay' | 'live-with-fallback'

export const USER_AGENT = 'sentinel-er (+https://github.com/shivang-goliyan/sentinel-er)'

export interface TapedResponse {
  status: number
  contentType: string
  body: Buffer
  fromTape: boolean
  ms: number
  url: string
  text(): string
  json<T = unknown>(): T
}

export interface TapeOptions extends Omit<RequestInit, 'body'> {
  body?: string
  timeoutMs?: number
  tape?: TapeMode
}

interface Tape {
  url: string
  method: string
  status: number
  content_type: string
  body_b64: string
  fetched_at: string
}

export class TapeMiss extends Error {}

let defaults = {
  dir: 'data/tapes',
  defaultMode: 'live-with-fallback' as TapeMode,
  onFallback: (_source: string, _url: string, _reason: string) => {},
}

export function setTapeDefaults(d: Partial<typeof defaults>) {
  defaults = { ...defaults, ...d }
}

function modeFor(source: string, override?: TapeMode): TapeMode {
  if (override) return override
  const fromEnv = process.env[`TAPE_MODE_${source.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`]
  return (fromEnv as TapeMode | undefined) ?? defaults.defaultMode
}

// Keys can sit in a query string or in the path (FIRMS puts its key in the path), so strip any
// secret-looking env value wherever it shows up.
export function redact(url: string): string {
  let out = url
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 8 || !/KEY|TOKEN|SECRET|PASSCODE|SID/.test(name)) continue
    out = out.split(value).join('***')
    out = out.split(encodeURIComponent(value)).join('***')
  }
  return out.replace(/([?&](?:key|api_key|apikey|token|access_token|map_key)=)[^&]*/gi, '$1***')
}

function tapePath(source: string, method: string, url: string, body?: string) {
  const key = createHash('sha1').update(`${method} ${redact(url)} ${body ?? ''}`).digest('hex')
  return join(defaults.dir, source, `${key}.json`)
}

function wrap(status: number, contentType: string, body: Buffer, fromTape: boolean, ms: number, url: string): TapedResponse {
  return {
    status,
    contentType,
    body,
    fromTape,
    ms,
    url: redact(url),
    text: () => body.toString('utf8'),
    json: <T>() => JSON.parse(body.toString('utf8')) as T,
  }
}

async function readTape(path: string, url: string): Promise<TapedResponse | null> {
  try {
    const t = JSON.parse(await readFile(path, 'utf8')) as Tape
    return wrap(t.status, t.content_type, Buffer.from(t.body_b64, 'base64'), true, 0, url)
  } catch {
    return null
  }
}

async function writeTape(path: string, method: string, url: string, res: TapedResponse) {
  const tape: Tape = {
    url: redact(url),
    method,
    status: res.status,
    content_type: res.contentType,
    body_b64: res.body.toString('base64'),
    fetched_at: new Date().toISOString(),
  }
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(tape))
}

async function goLive(url: string, opts: TapeOptions): Promise<TapedResponse> {
  const started = Date.now()
  const { timeoutMs = 15_000, tape: _tape, ...init } = opts
  const signal = init.signal ?? AbortSignal.timeout(timeoutMs)
  const res = await fetch(url, {
    ...init,
    signal,
    headers: { 'user-agent': USER_AGENT, ...(init.headers as Record<string, string> | undefined) },
  })
  const body = Buffer.from(await res.arrayBuffer())
  return wrap(res.status, res.headers.get('content-type') ?? '', body, false, Date.now() - started, url)
}

const worthKeeping = (r: TapedResponse) => r.status >= 200 && r.status < 400
const worthFallingBack = (r: TapedResponse) => r.status === 429 || r.status >= 500

export async function tapedFetch(source: string, url: string, opts: TapeOptions = {}): Promise<TapedResponse> {
  const method = (opts.method ?? 'GET').toUpperCase()
  const path = tapePath(source, method, url, opts.body)
  const mode = modeFor(source, opts.tape)

  if (mode === 'replay') {
    const t = await readTape(path, url)
    if (!t) throw new TapeMiss(`no tape for ${source} ${redact(url)}`)
    return t
  }
  if (mode === 'live') return goLive(url, opts)

  let live: TapedResponse | null = null
  let failure = ''
  try {
    live = await goLive(url, opts)
  } catch (err) {
    if (mode === 'record') throw err
    failure = err instanceof Error ? err.message : String(err)
  }
  if (live && worthKeeping(live)) {
    await writeTape(path, method, url, live)
    return live
  }
  if (mode === 'record' || (live && !worthFallingBack(live))) {
    if (live) return live
  }
  const t = await readTape(path, url)
  if (!t) {
    if (live) return live
    throw new Error(`${source} unreachable and nothing recorded: ${failure}`)
  }
  defaults.onFallback(source, redact(url), live ? `HTTP ${live.status}` : failure)
  return t
}
