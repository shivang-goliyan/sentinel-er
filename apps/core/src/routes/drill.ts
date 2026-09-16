import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Orchestrator } from '../crew/orchestrator.ts'
import { drillEvent } from '../modes/drill.ts'
import type { Deps } from '../server.ts'

const Body = z
  .object({
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    mag: z.number().min(3).max(9.5).optional(),
    depth_km: z.number().min(0).max(700).optional(),
    at: z.string().datetime().optional(),
  })
  .strict()

export function registerDrill(app: FastifyInstance, deps: Deps) {
  const crew = new Orchestrator(deps)

  app.post('/api/drill', { preHandler: deps.requireOperator }, async (req, reply) => {
    const body = Body.safeParse(req.body ?? {})
    if (!body.success) {
      return reply.code(400).send({ error: 'That drill doesn\'t look right. Send lat, lon, mag, depth_km (all optional).' })
    }
    const event = drillEvent(body.data)
    const runId = crew.begin(event, 'drill')
    return reply.code(202).send({ event_id: event.id, run_id: runId, title: event.title })
  })
}
