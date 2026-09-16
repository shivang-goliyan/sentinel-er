import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Deps } from '../server.ts'

const Page = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
})

export function registerLog(app: FastifyInstance, { chain }: Deps) {
  app.get('/api/log', async (req) => {
    const { after, limit } = Page.parse(req.query)
    return { entries: chain.after(after, limit), head: chain.head().seq }
  })

  app.get('/api/log/verify', async () => chain.verify())
}
