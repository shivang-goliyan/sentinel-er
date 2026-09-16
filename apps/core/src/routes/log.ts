import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Deps } from '../server.ts'

const Page = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
})

export function registerLog(app: FastifyInstance, { chain }: Deps) {
  app.get('/api/log', async (req, reply) => {
    const page = Page.safeParse(req.query)
    if (!page.success) return reply.code(400).send({ error: 'after must be 0 or more, and limit between 1 and 1000.' })
    return { entries: chain.after(page.data.after, page.data.limit), head: chain.head().seq }
  })

  app.get('/api/log/verify', async () => chain.verify())
}
