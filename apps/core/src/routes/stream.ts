import { once } from 'node:events'
import type { FastifyInstance } from 'fastify'
import type { LogEntry } from '@sentinel/shared'
import type { Deps } from '../server.ts'

const PAGE = 500
const PING_MS = 15_000
// history goes out a page at a time, waiting for the socket whenever this much is queued
const HIGH_WATER = 1024 * 1024
// a console that stops reading live entries shouldn't pin megabytes of log in memory
const MAX_BUFFERED = 8 * 1024 * 1024

export function registerStream(app: FastifyInstance, { chain, bus }: Deps) {
  app.get<{ Querystring: { after?: string } }>('/api/stream', (req, reply) => {
    const resumeFrom = req.headers['last-event-id'] ?? req.query.after ?? '0'
    let cursor = Number.parseInt(String(resumeFrom), 10) || 0

    reply.hijack()
    const res = reply.raw
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write('retry: 2000\n\n')

    const gone = new AbortController()
    const write = (e: LogEntry) => {
      if (e.seq <= cursor || res.destroyed) return
      cursor = e.seq
      res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`)
    }

    // entries that land while the history is still going out wait here
    let live = false
    const waiting: LogEntry[] = []
    const off = bus.on((e) => {
      if (!live) return void waiting.push(e)
      write(e)
      if (res.writableLength > MAX_BUFFERED) res.destroy()
    })
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS)
    req.raw.on('close', () => {
      clearInterval(ping)
      off()
      gone.abort()
    })

    void (async () => {
      try {
        for (;;) {
          const page = chain.after(cursor, PAGE)
          for (const e of page) write(e)
          if (res.writableLength > HIGH_WATER) await once(res, 'drain', { signal: gone.signal })
          if (page.length < PAGE) break
        }
        for (const e of waiting.splice(0)) write(e)
        live = true
      } catch {
        // the console went away mid-history
      }
    })()
  })
}
