import { timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'

const MAX_MISSES = 10
const LOCKOUT_MS = 10 * 60_000

export function operatorGuard(passcode: string) {
  const want = Buffer.from(passcode)
  const misses = new Map<string, { n: number; until: number }>()

  return async function requireOperator(req: FastifyRequest, reply: FastifyReply) {
    const m = misses.get(req.ip)
    if (m && m.n >= MAX_MISSES && Date.now() < m.until) {
      return reply.code(429).send({ error: 'Too many wrong passcodes. Try again in a few minutes.' })
    }
    const got = Buffer.from(String(req.headers['x-operator'] ?? ''))
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      misses.set(req.ip, { n: (m?.n ?? 0) + 1, until: Date.now() + LOCKOUT_MS })
      return reply.code(401).send({ error: 'Operator passcode needed.' })
    }
    misses.delete(req.ip)
  }
}
