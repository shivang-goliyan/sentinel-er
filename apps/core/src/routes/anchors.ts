import type { FastifyInstance } from 'fastify'
import type { Deps } from '../server.ts'

export function registerAnchors(app: FastifyInstance, { anchors, requireOperator }: Deps) {
  app.get('/api/anchors', async () => ({ anchors: anchors.list() }))

  // the raw .ots proof, so anyone can check it with the standard OpenTimestamps tools
  app.get<{ Params: { id: string } }>('/api/anchors/:id/proof', async (req, reply) => {
    const proof = anchors.proof(Number(req.params.id))
    if (!proof) return reply.code(404).send({ error: 'No such anchor.' })
    return reply
      .type('application/octet-stream')
      .header('content-disposition', `attachment; filename="sentinel-log-${req.params.id}.ots"`)
      .send(proof)
  })

  app.get<{ Params: { id: string } }>('/api/anchors/:id/check', async (req, reply) => {
    const result = anchors.checkAgainstLog(Number(req.params.id))
    return result ?? reply.code(404).send({ error: 'No such anchor.' })
  })

  app.post('/api/anchors', { preHandler: requireOperator }, async () => {
    const id = await anchors.submit()
    return { id, note: id === null ? 'Nothing new to anchor.' : 'Submitted to the OpenTimestamps calendars.' }
  })
}
