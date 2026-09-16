import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import type Database from 'better-sqlite3'
import { operatorGuard } from './auth.ts'
import type { Bus } from './bus.ts'
import type { Config } from './config.ts'
import type { Db } from './db/index.ts'
import type { LogChain } from './log/chain.ts'
import { registerLog } from './routes/log.ts'
import { registerOperator } from './routes/operator.ts'
import { registerStream } from './routes/stream.ts'
import type { Switches } from './switches.ts'

export interface Deps {
  config: Config
  sqlite: Database.Database
  db: Db['db']
  bus: Bus
  chain: LogChain
  switches: Switches
  requireOperator: ReturnType<typeof operatorGuard>
}

export async function buildServer(deps: Omit<Deps, 'requireOperator'>) {
  const app = Fastify({
    logger: deps.config.NODE_ENV === 'test' ? false : { level: 'info' },
    trustProxy: '127.0.0.1',
  })
  const full: Deps = { ...deps, requireOperator: operatorGuard(deps.config.operatorPasscode) }

  await app.register(websocket)
  registerStream(app, full)
  registerLog(app, full)
  registerOperator(app, full)

  const startedAt = Date.now()
  app.get('/api/health', async () => ({
    ok: true,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    head: deps.chain.head().seq,
    listeners: deps.bus.size,
  }))

  return app
}
