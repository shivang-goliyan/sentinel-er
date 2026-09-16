// The only file that knows which model providers exist. All of them speak the OpenAI chat format.
import OpenAI, { APIError } from 'openai'
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions'

const PROVIDERS = {
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai/', env: 'GEMINI_API_KEY', resetsAtPacificMidnight: true },
  groq: { base: 'https://api.groq.com/openai/v1', env: 'GROQ_API_KEY', resetsAtPacificMidnight: false },
  openrouter: { base: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEY', resetsAtPacificMidnight: false },
} as const
type Provider = keyof typeof PROVIDERS

export type Lane = 'voice' | 'text'
export type Message = ChatCompletionMessageParam
export type Tool = ChatCompletionTool

export interface ChatRequest {
  lane: Lane
  messages: Message[]
  tools?: Tool[]
  temperature?: number
  maxTokens?: number
  json?: boolean
  signal?: AbortSignal
}

export type StreamPart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'done'; provider: string; model: string; ms: number; firstTokenMs: number }

export interface ChatResult {
  text: string
  toolCalls: { id: string; name: string; arguments: string }[]
  provider: string
  model: string
  ms: number
}

interface Link {
  provider: Provider
  model: string
  key: string
  keyIndex: number
}

export class NoModelLeft extends Error {}

// swapped out in tests
export type ClientFactory = (base: string, key: string) => {
  create(body: Record<string, unknown>, signal: AbortSignal): Promise<AsyncIterable<ChatCompletionChunk>>
}

let makeClient: ClientFactory = (base, key) => {
  const client = new OpenAI({ apiKey: key, baseURL: base, maxRetries: 0 })
  return {
    create: (body, signal) =>
      client.chat.completions.create(body as never, { signal }) as unknown as Promise<AsyncIterable<ChatCompletionChunk>>,
  }
}

export function setClientFactory(f: ClientFactory) {
  makeClient = f
}

const FIRST_TOKEN_MS: Record<Lane, number> = { voice: 4_000, text: 45_000 }
const cooling = new Map<string, number>()
const stats = new Map<string, { calls: number; failures: number; lastMs: number; lastError?: string }>()

export function resetLlmState() {
  cooling.clear()
  stats.clear()
}

export function llmStats() {
  return Object.fromEntries(stats)
}

export function keysFor(provider: Provider, env: NodeJS.ProcessEnv = process.env): string[] {
  const name = PROVIDERS[provider].env
  const names = [name, ...Array.from({ length: 8 }, (_, i) => `${name}_${i + 2}`)]
  return names.map((n) => env[n]).filter((v): v is string => Boolean(v))
}

export function parseChain(spec: string): { provider: Provider; model: string }[] {
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const cut = entry.indexOf(':')
      const head = cut === -1 ? '' : entry.slice(0, cut)
      if (head in PROVIDERS) return { provider: head as Provider, model: entry.slice(cut + 1) }
      return { provider: 'openrouter' as Provider, model: entry }
    })
}

function linksFor(lane: Lane, env: NodeJS.ProcessEnv): Link[] {
  const spec = lane === 'voice' ? env.LLM_CHAIN_VOICE : env.LLM_CHAIN_TEXT
  const chain = parseChain(
    spec ?? (lane === 'voice' ? 'gemini:gemini-3.5-flash-lite,groq:openai/gpt-oss-20b' : 'gemini:gemini-3.5-flash,groq:openai/gpt-oss-120b'),
  )
  return chain.flatMap(({ provider, model }) =>
    keysFor(provider, env).map((key, keyIndex) => ({ provider, model, key, keyIndex })),
  )
}

// limits are per model and per project/org, so that's the unit that cools down
const linkId = (l: Link) => `${l.provider}#${l.keyIndex}#${l.model}`

function msToPacificMidnight(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now)
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return 86_400_000 - (n('hour') * 3600 + n('minute') * 60 + n('second')) * 1000 + 1000
}

function coolFor(link: Link, err: unknown): number {
  if (err instanceof APIError || (err && typeof err === 'object' && 'status' in err)) {
    const status = (err as { status?: number }).status ?? 0
    const text = String((err as Error).message ?? '').toLowerCase()
    if (status === 429) {
      const daily = /per ?day|daily|perday|requests_per_day|tokens per day/.test(text)
      if (daily) return PROVIDERS[link.provider].resetsAtPacificMidnight ? msToPacificMidnight() : 3_600_000
      return 60_000
    }
    if (status === 401 || status === 403) return 24 * 3_600_000
    if (status === 400 || status === 404) return 10 * 60_000
    return 15_000
  }
  return 15_000
}

function note(link: Link, ok: boolean, ms: number, error?: string) {
  const id = linkId(link)
  const s = stats.get(id) ?? { calls: 0, failures: 0, lastMs: 0 }
  s.calls++
  if (!ok) {
    s.failures++
    s.lastError = error
  }
  s.lastMs = ms
  stats.set(id, s)
}

function bodyFor(link: Link, req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: link.model,
    messages: req.messages,
    stream: true,
    temperature: req.temperature ?? 0.3,
  }
  if (req.maxTokens) body.max_tokens = req.maxTokens
  if (req.tools?.length) body.tools = req.tools
  if (req.json) body.response_format = { type: 'json_object' }
  const effort = link.provider === 'gemini' ? process.env.GEMINI_REASONING_EFFORT : undefined
  if (effort) body.reasoning_effort = effort
  return body
}

export async function* stream(req: ChatRequest, env: NodeJS.ProcessEnv = process.env): AsyncGenerator<StreamPart> {
  const links = linksFor(req.lane, env)
  if (links.length === 0) throw new NoModelLeft(`no API keys configured for the ${req.lane} chain`)
  let lastError = ''

  for (const link of links) {
    const id = linkId(link)
    if ((cooling.get(id) ?? 0) > Date.now()) continue
    if (req.signal?.aborted) throw req.signal.reason

    const started = Date.now()
    const ctrl = new AbortController()
    const onAbort = () => ctrl.abort(req.signal?.reason)
    req.signal?.addEventListener('abort', onAbort, { once: true })
    const slow = setTimeout(() => ctrl.abort(new Error('first token too slow')), FIRST_TOKEN_MS[req.lane])

    let iterator: AsyncIterator<ChatCompletionChunk>
    let first: IteratorResult<ChatCompletionChunk>
    try {
      const source = await makeClient(PROVIDERS[link.provider].base, link.key).create(bodyFor(link, req), ctrl.signal)
      iterator = source[Symbol.asyncIterator]()
      first = await iterator.next()
    } catch (err) {
      clearTimeout(slow)
      req.signal?.removeEventListener('abort', onAbort)
      if (req.signal?.aborted) throw req.signal.reason
      lastError = `${link.provider}/${link.model}: ${err instanceof Error ? err.message : String(err)}`
      cooling.set(id, Date.now() + coolFor(link, err))
      note(link, false, Date.now() - started, lastError)
      continue
    }
    clearTimeout(slow)
    const firstTokenMs = Date.now() - started

    // committed to this link now; a failure from here on is the caller's problem
    const calls = new Map<number, { id: string; name: string; arguments: string }>()
    try {
      let result = first
      while (!result.done) {
        const choice = result.value.choices?.[0]
        const delta = choice?.delta
        if (delta?.content) yield { type: 'text', text: delta.content }
        for (const tc of delta?.tool_calls ?? []) {
          const slot = calls.get(tc.index) ?? { id: '', name: '', arguments: '' }
          if (tc.id) slot.id = tc.id
          if (tc.function?.name) slot.name += tc.function.name
          if (tc.function?.arguments) slot.arguments += tc.function.arguments
          calls.set(tc.index, slot)
        }
        result = await iterator.next()
      }
    } finally {
      req.signal?.removeEventListener('abort', onAbort)
    }
    for (const [i, c] of calls) yield { type: 'tool_call', id: c.id || `call_${i}`, name: c.name, arguments: c.arguments || '{}' }
    const ms = Date.now() - started
    note(link, true, ms)
    yield { type: 'done', provider: link.provider, model: link.model, ms, firstTokenMs }
    return
  }
  throw new NoModelLeft(`every model in the ${req.lane} chain failed or is cooling down. Last: ${lastError || 'none tried'}`)
}

export async function chat(req: ChatRequest, env: NodeJS.ProcessEnv = process.env): Promise<ChatResult> {
  let text = ''
  const toolCalls: ChatResult['toolCalls'] = []
  let meta = { provider: '', model: '', ms: 0 }
  for await (const part of stream(req, env)) {
    if (part.type === 'text') text += part.text
    else if (part.type === 'tool_call') toolCalls.push({ id: part.id, name: part.name, arguments: part.arguments })
    else meta = { provider: part.provider, model: part.model, ms: part.ms }
  }
  return { text, toolCalls, ...meta }
}
