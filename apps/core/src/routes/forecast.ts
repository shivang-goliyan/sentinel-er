import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Orchestrator } from '../crew/orchestrator.ts'
import type { Deps } from '../server.ts'

const Body = z
  .object({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    label: z.string().trim().min(1).max(120),
  })
  .strict()

export function registerForecast(app: FastifyInstance, deps: Deps) {
  const crew = new Orchestrator(deps)

  app.post('/api/forecast', { preHandler: deps.requireOperator }, async (req, reply) => {
    const body = Body.safeParse(req.body ?? {})
    if (!body.success) return reply.code(400).send({ error: 'Send lat, lon and a label for the place.' })
    const { lat, lon, label } = body.data
    const runId = crew.beginForecast(label, lat, lon)
    return reply.code(202).send({ run_id: runId, label })
  })
}
