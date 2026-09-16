import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Deps } from '../server.ts'

const Toggle = z.object({ on: z.boolean() })
const Note = z.object({ text: z.string().trim().min(1).max(500) })

export function registerOperator(app: FastifyInstance, { chain, switches, requireOperator, config }: Deps) {
  app.get('/api/state', async () => ({
    approval_on: switches.approval,
    drill_on: switches.drill,
    mode: switches.drill ? 'drill' : 'live',
    operator_required: true,
    inject_fault: config.DEMO_INJECT_FAULT || null,
  }))

  app.post('/api/operator/check', { preHandler: requireOperator }, async (_req, reply) => reply.code(204).send())

  app.post<{ Params: { name: 'approval' | 'drill' } }>(
    '/api/switch/:name',
    { preHandler: requireOperator },
    async (req, reply) => {
      const name = req.params.name
      if (name !== 'approval' && name !== 'drill') return reply.code(404).send({ error: 'No such switch.' })
      const body = Toggle.safeParse(req.body)
      if (!body.success) return reply.code(400).send({ error: 'Send {"on": true} or {"on": false}.' })
      const current = name === 'approval' ? switches.approval : switches.drill
      if (current !== body.data.on) chain.append('operator', 'switch.changed', { name, on: body.data.on })
      return { name, on: body.data.on }
    },
  )

  app.post('/api/operator/note', { preHandler: requireOperator }, async (req, reply) => {
    const body = Note.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'A note needs some text (500 characters at most).' })
    const entry = chain.append('operator', 'note', { text: body.data.text })
    return { seq: entry.seq }
  })
}
