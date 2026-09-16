import { Bus } from '../src/bus.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db/index.ts'
import { FactStore } from '../src/facts/store.ts'
import { Anchors, type Notary } from '../src/log/anchor.ts'
import { LogChain } from '../src/log/chain.ts'
import { ActiveRun } from '../src/runs.ts'
import { buildServer, serverDeps } from '../src/server.ts'
import { Switches } from '../src/switches.ts'
import type { VoiceOverrides } from '../src/voice/index.ts'

export const PASS = 'test-passcode-123'

export const notarised: string[] = []
export const fakeNotary: Notary = {
  async stamp(hex) {
    notarised.push(hex)
    return Buffer.from(`pending:${hex}`)
  },
  async upgrade(proof) {
    const text = proof.toString()
    return text.startsWith('pending:') ? { proof: Buffer.from(text.replace('pending:', 'bitcoin:')), height: 912345 } : { proof: null, height: null }
  },
}

export function makeDeps(extra: Record<string, string> = {}) {
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', OPERATOR_PASSCODE: PASS, ...extra })
  const { sqlite, db } = openDb(':memory:')
  const bus = new Bus()
  const chain = new LogChain(sqlite, bus)
  const switches = new Switches(sqlite, bus, config)
  const facts = new FactStore(sqlite, chain)
  const activeRun = new ActiveRun(sqlite, bus)
  const anchors = new Anchors(sqlite, chain, fakeNotary)
  return { config, sqlite, db, bus, chain, facts, switches, activeRun, anchors }
}

export async function makeApp(extra: Record<string, string> = {}, overrides: VoiceOverrides = {}) {
  const deps = makeDeps(extra)
  const app = await buildServer(deps, { telephony: null, ...overrides })
  return { app, ...deps, voice: serverDeps.get(app)!.voice }
}
