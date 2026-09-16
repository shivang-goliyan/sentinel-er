import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions'
import { NoModelLeft, chat, keysFor, parseChain, resetLlmState, setClientFactory, stream } from '../src/llm/chain.ts'

type Behaviour = { fail?: { status: number; message: string }; chunks?: Partial<ChatCompletionChunk>[] }
const plan = new Map<string, Behaviour>()
const calls: string[] = []

function chunk(content: string): Partial<ChatCompletionChunk> {
  return { choices: [{ index: 0, delta: { content }, finish_reason: null, logprobs: null }] }
}

beforeEach(() => {
  resetLlmState()
  plan.clear()
  calls.length = 0
  setClientFactory((base, key) => ({
    async create(body) {
      const id = `${base.includes('groq') ? 'groq' : 'gemini'}:${key}:${String(body.model)}`
      calls.push(id)
      const b = plan.get(id) ?? { chunks: [chunk('ok')] }
      if (b.fail) throw Object.assign(new Error(b.fail.message), { status: b.fail.status })
      return (async function* () {
        for (const c of b.chunks ?? []) yield c as ChatCompletionChunk
      })()
    },
  }))
})

const env = {
  LLM_CHAIN_VOICE: 'gemini:flash-lite,groq:oss-20b',
  GEMINI_API_KEY: 'g1',
  GEMINI_API_KEY_2: 'g2',
  GROQ_API_KEY: 'q1',
}

describe('chain parsing', () => {
  it('reads provider prefixes', () => {
    expect(parseChain('gemini:a, groq:openai/b ,c')).toEqual([
      { provider: 'gemini', model: 'a' },
      { provider: 'groq', model: 'openai/b' },
      { provider: 'openrouter', model: 'c' },
    ])
  })

  it('collects numbered keys', () => {
    expect(keysFor('gemini', { GEMINI_API_KEY: 'a', GEMINI_API_KEY_3: 'c' })).toEqual(['a', 'c'])
  })
})

describe('fallback', () => {
  it('uses the first healthy link', async () => {
    const r = await chat({ lane: 'voice', messages: [] }, env)
    expect(r).toMatchObject({ text: 'ok', provider: 'gemini', model: 'flash-lite' })
    expect(calls).toEqual(['gemini:g1:flash-lite'])
  })

  it('moves past a rate limit', async () => {
    plan.set('gemini:g1:flash-lite', { fail: { status: 429, message: 'Too many requests per minute' } })
    const r = await chat({ lane: 'voice', messages: [] }, env)
    expect(calls).toEqual(['gemini:g1:flash-lite', 'gemini:g2:flash-lite'])
    expect(r.provider).toBe('gemini')
  })

  it('skips a cooling key next time', async () => {
    plan.set('gemini:g1:flash-lite', { fail: { status: 429, message: 'quota exceeded for requests per day' } })
    await chat({ lane: 'voice', messages: [] }, env)
    calls.length = 0
    await chat({ lane: 'voice', messages: [] }, env)
    expect(calls).toEqual(['gemini:g2:flash-lite'])
  })

  it('falls through to groq', async () => {
    plan.set('gemini:g1:flash-lite', { fail: { status: 503, message: 'overloaded' } })
    plan.set('gemini:g2:flash-lite', { fail: { status: 500, message: 'boom' } })
    const r = await chat({ lane: 'voice', messages: [] }, env)
    expect(r.provider).toBe('groq')
  })

  it('says so when nothing works', async () => {
    for (const k of ['gemini:g1:flash-lite', 'gemini:g2:flash-lite', 'groq:q1:oss-20b']) {
      plan.set(k, { fail: { status: 401, message: 'bad key' } })
    }
    await expect(chat({ lane: 'voice', messages: [] }, env)).rejects.toBeInstanceOf(NoModelLeft)
  })

  it('assembles streamed tool calls', async () => {
    plan.set('gemini:g1:flash-lite', {
      chunks: [
        {
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'get_fact', arguments: '{"id":' } }] },
              finish_reason: null,
              logprobs: null,
            },
          ],
        },
        {
          choices: [
            { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"F3"}' } }] }, finish_reason: 'tool_calls', logprobs: null },
          ],
        },
      ],
    })
    const parts = []
    for await (const p of stream({ lane: 'voice', messages: [] }, env)) parts.push(p)
    expect(parts[0]).toEqual({ type: 'tool_call', id: 'c1', name: 'get_fact', arguments: '{"id":"F3"}' })
  })
})
