import type { LogEntry } from '@sentinel/shared'

type Listener = (entry: LogEntry) => void

export class Bus {
  private listeners = new Set<Listener>()

  on(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit(entry: LogEntry) {
    for (const fn of this.listeners) {
      try {
        fn(entry)
      } catch (err) {
        console.error('bus listener threw', err)
      }
    }
  }

  get size() {
    return this.listeners.size
  }
}
