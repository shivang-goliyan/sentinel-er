import type Database from 'better-sqlite3'
import type { Bus } from './bus.ts'

// Which run is live right now, read off the log.
export class ActiveRun {
  private id: string | null = null

  constructor(sqlite: Database.Database, bus: Bus) {
    const last = sqlite
      .prepare<[], { run_id: string; kind: string }>(
        "SELECT run_id, kind FROM log WHERE kind IN ('run.started', 'run.ended') AND run_id IS NOT NULL ORDER BY seq DESC LIMIT 1",
      )
      .get()
    if (last?.kind === 'run.started') this.id = last.run_id
    bus.on((e) => {
      if (e.kind === 'run.started') this.id = e.run_id
      else if (e.kind === 'run.ended' && e.run_id === this.id) this.id = null
    })
  }

  get current() {
    return this.id
  }
}
