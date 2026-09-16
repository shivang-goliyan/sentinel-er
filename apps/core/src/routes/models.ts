import type { FastifyInstance } from 'fastify'
import type { Deps } from '../server.ts'

// Model cards come from the science service; the console only talks to the core.
const CARDS: Record<string, string> = {
  casualty: '/casualty/card',
  smoke: '/smoke/card',
}

export function registerModels(app: FastifyInstance, { config }: Deps) {
  app.get<{ Params: { name: string } }>('/api/models/:name', async (req, reply) => {
    const path = CARDS[req.params.name]
    if (!path) return reply.code(404).send({ error: 'No such model.' })
    try {
      const res = await fetch(`${config.SCIENCE_URL}${path}`, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) return reply.code(502).send({ error: `The science service said ${res.status}.` })
      return reply.header('cache-control', 'max-age=300').send(await res.json())
    } catch {
      return reply.code(503).send({ error: 'The science service is not reachable.' })
    }
  })
}
