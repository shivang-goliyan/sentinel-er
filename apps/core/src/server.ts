import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import type Database from 'better-sqlite3'
import { operatorGuard } from './auth.ts'
import type { Bus } from './bus.ts'
import type { Config } from './config.ts'
import type { Db } from './db/index.ts'
import type { FactStore } from './facts/store.ts'
import type { LogChain } from './log/chain.ts'
import { registerLog } from './routes/log.ts'
import { registerOperator } from './routes/operator.ts'
import { registerStream } from './routes/stream.ts'
import { registerVoice } from './routes/voice.ts'
import type { ActiveRun } from './runs.ts'
import type { Switches } from './switches.ts'
import { createVoice, type Voice, type VoiceOverrides } from './voice/index.ts'

export interface Deps {
  config: Config
  sqlite: Database.Database
  db: Db['db']
  bus: Bus
  chain: LogChain
  facts: FactStore
  switches: Switches
  activeRun: ActiveRun
  voice: Voice
  requireOperator: ReturnType<typeof operatorGuard>
}

// the app is thenable, so anything hung off it gets lost when awaited; look deps up here instead
export const serverDeps = new WeakMap<object, Deps>()

export async function buildServer(deps: Omit<Deps, 'requireOperator' | 'voice'>, overrides: VoiceOverrides = {}) {
  const app = Fastify({
    logger:
      deps.config.NODE_ENV === 'test'
        ? false
        : {
            level: 'info',
            serializers: {
              // the operator passcode can ride in ?op= for audio and sockets; keep it out of logs
              req: (req) => ({ method: req.method, url: String(req.url).replace(/([?&](?:op|k)=)[^&]*/g, '$1***') }),
            },
          },
    trustProxy: '127.0.0.1',
  })
  const full: Deps = {
    ...deps,
    voice: createVoice(deps, overrides),
    requireOperator: operatorGuard(deps.config.operatorPasscode),
  }

  await app.register(websocket)
  registerStream(app, full)
  registerLog(app, full)
  registerOperator(app, full)
  await registerVoice(app, full)

  const startedAt = Date.now()
  app.get('/api/health', async () => ({
    ok: true,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    head: deps.chain.head().seq,
    listeners: deps.bus.size,
  }))

  serverDeps.set(app, full)
  return app
}
