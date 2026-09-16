import { Bus } from '../src/bus.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db/index.ts'
import { FactStore } from '../src/facts/store.ts'
import { LogChain } from '../src/log/chain.ts'
import { ActiveRun } from '../src/runs.ts'
import { buildServer, serverDeps } from '../src/server.ts'
import { Switches } from '../src/switches.ts'
import type { VoiceOverrides } from '../src/voice/index.ts'

export const PASS = 'test-passcode-123'

export function makeDeps(extra: Record<string, string> = {}) {
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', OPERATOR_PASSCODE: PASS, ...extra })
  const { sqlite, db } = openDb(':memory:')
  const bus = new Bus()
  const chain = new LogChain(sqlite, bus)
  const switches = new Switches(sqlite, bus, config)
  const facts = new FactStore(sqlite, chain)
  const activeRun = new ActiveRun(sqlite, bus)
  return { config, sqlite, db, bus, chain, facts, switches, activeRun }
}

export async function makeApp(extra: Record<string, string> = {}, overrides: VoiceOverrides = {}) {
  const deps = makeDeps(extra)
  const app = await buildServer(deps, { telephony: null, ...overrides })
  return { app, ...deps, voice: serverDeps.get(app)!.voice }
}
