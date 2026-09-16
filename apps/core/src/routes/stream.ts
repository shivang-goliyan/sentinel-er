import type { FastifyInstance } from 'fastify'
import type { LogEntry } from '@sentinel/shared'
import type { Deps } from '../server.ts'

const PAGE = 500
const PING_MS = 15_000
// a console that stops reading shouldn't pin megabytes of log in memory
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

    const send = (e: LogEntry) => {
      if (e.seq <= cursor) return
      cursor = e.seq
      res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`)
      if (res.writableLength > MAX_BUFFERED) res.destroy()
    }

    // the backlog read is synchronous, so nothing can be appended between it and the subscribe
    for (;;) {
      const page = chain.after(cursor, PAGE)
      for (const e of page) send(e)
      if (page.length < PAGE) break
    }
    const off = bus.on(send)
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS)

    req.raw.on('close', () => {
      clearInterval(ping)
      off()
    })
  })
}
