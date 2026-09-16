import { createReadStream, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { Deps } from '../server.ts'

const FILES: Record<string, string> = {
  'sitrep.pdf': 'application/pdf',
  'drone.plan': 'application/json',
}

// Run artifacts are public: they're built from public data and say DRILL on every page.
export function registerArtifacts(app: FastifyInstance, { config }: Deps) {
  app.get<{ Params: { id: string; file: string } }>('/api/runs/:id/:file', async (req, reply) => {
    const { id, file } = req.params
    const type = FILES[file]
    if (!type || !/^[\w-]{1,64}$/.test(id)) return reply.code(404).send({ error: 'No such file.' })
    const path = join(config.artifactsDir, id, file)
    if (!existsSync(path)) return reply.code(404).send({ error: 'Not produced yet.' })
    return reply.type(type).header('content-disposition', `inline; filename="${id}-${file}"`).send(createReadStream(path))
  })
}
