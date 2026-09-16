import { Bus } from './bus.ts'
import { loadConfig } from './config.ts'
import { openDb } from './db/index.ts'
import { FactStore } from './facts/store.ts'
import { LogChain } from './log/chain.ts'
import { buildServer } from './server.ts'
import { Switches } from './switches.ts'
import { setTapeDefaults } from './tape.ts'

const config = loadConfig()
const { sqlite, db } = openDb(config.databasePath)
const bus = new Bus()
const chain = new LogChain(sqlite, bus)
const switches = new Switches(sqlite, bus, config)
const facts = new FactStore(sqlite, chain)

setTapeDefaults({
  dir: config.tapeDir,
  defaultMode: config.TAPE_MODE_DEFAULT,
  onFallback: (source, url, reason) => chain.append('system', 'fallback.used', { source, url, reason }),
})

const app = await buildServer({ config, sqlite, db, bus, chain, facts, switches })
await app.listen({ host: config.HOST, port: config.PORT })

let closing = false
async function stop() {
  if (closing) return
  closing = true
  await app.close()
  sqlite.close()
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
