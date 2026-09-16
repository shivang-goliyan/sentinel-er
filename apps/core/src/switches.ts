import type Database from 'better-sqlite3'
import type { Bus } from './bus.ts'
import type { Config } from './config.ts'

type Name = 'approval' | 'drill'

// Switch state lives in the log like everything else; this just keeps the latest value handy.
export class Switches {
  private state: Record<Name, boolean>

  constructor(sqlite: Database.Database, bus: Bus, config: Config) {
    this.state = { approval: config.APPROVAL_DEFAULT, drill: config.DRILL }
    const rows = sqlite
      .prepare<[], { payload: string }>("SELECT payload FROM log WHERE kind = 'switch.changed' ORDER BY seq")
      .all()
    for (const r of rows) {
      const p = JSON.parse(r.payload) as { name: Name; on: boolean }
      this.state[p.name] = p.on
    }
    bus.on((e) => {
      if (e.kind === 'switch.changed') this.state[e.payload.name] = e.payload.on
    })
  }

  get approval() {
    return this.state.approval
  }

  get drill() {
    return this.state.drill
  }
}
