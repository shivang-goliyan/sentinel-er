import { Bus } from '../src/bus.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db/index.ts'
import { LogChain } from '../src/log/chain.ts'
import { buildServer } from '../src/server.ts'
import { Switches } from '../src/switches.ts'

export const PASS = 'test-passcode-123'

export function makeDeps(extra: Record<string, string> = {}) {
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', OPERATOR_PASSCODE: PASS, ...extra })
  const { sqlite, db } = openDb(':memory:')
  const bus = new Bus()
  const chain = new LogChain(sqlite, bus)
  const switches = new Switches(sqlite, bus, config)
  return { config, sqlite, db, bus, chain, switches }
}

export async function makeApp(extra: Record<string, string> = {}) {
  const deps = makeDeps(extra)
  const app = await buildServer(deps)
  return { app, ...deps }
}
