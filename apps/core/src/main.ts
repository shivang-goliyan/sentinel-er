import { Bus } from './bus.ts'
import { loadConfig } from './config.ts'
import { openDb } from './db/index.ts'
import { FactStore } from './facts/store.ts'
import { Anchors, openTimestamps } from './log/anchor.ts'
import { LogChain } from './log/chain.ts'
import { Orchestrator } from './crew/orchestrator.ts'
import { FeedWatcher } from './feeds/watcher.ts'
import { ActiveRun } from './runs.ts'
import { buildServer, serverDeps } from './server.ts'
import { Switches } from './switches.ts'
import { setTapeDefaults } from './tape.ts'

const config = loadConfig()
const { sqlite, db } = openDb(config.databasePath)
const bus = new Bus()
const chain = new LogChain(sqlite, bus)
const switches = new Switches(sqlite, bus, config)
const facts = new FactStore(sqlite, chain)
const activeRun = new ActiveRun(sqlite, bus)
const anchors = new Anchors(sqlite, chain, openTimestamps())

// anchor at the end of every run, and every 15 minutes while things are happening
bus.on((e) => {
  if (e.kind === 'run.ended') void anchors.submit(e.run_id)
})
const anchorTimer = setInterval(() => void anchors.submit(), 15 * 60_000)
const upgradeTimer = setInterval(() => void anchors.upgradePending(), 30 * 60_000)

setTapeDefaults({
  dir: config.tapeDir,
  defaultMode: config.TAPE_MODE_DEFAULT,
  onFallback: (source, url, reason) => chain.append('system', 'fallback.used', { source, url, reason }),
})

const app = await buildServer({ config, sqlite, db, bus, chain, facts, switches, activeRun, anchors })
const crew = new Orchestrator(serverDeps.get(app)!)
const watcher = new FeedWatcher({
  chain,
  switches,
  minPop: config.TIER2_MIN_POP,
  begin: (event) => crew.begin(event, 'live'),
})
app.get('/api/feeds', async () => ({ enabled: config.FEEDS, health: watcher.health }))

await app.listen({ host: config.HOST, port: config.PORT })
if (config.FEEDS) watcher.start()

let closing = false
async function stop() {
  if (closing) return
  closing = true
  clearInterval(anchorTimer)
  watcher.stop()
  clearInterval(upgradeTimer)
  await app.close()
  sqlite.close()
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
