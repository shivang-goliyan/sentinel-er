import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net'
import { repoRoot } from '../../apps/core/src/config.ts'
import { USER_AGENT } from '../../apps/core/src/tape.ts'

setDefaultAutoSelectFamilyAttemptTimeout(2_000)

export const rawDir = join(repoRoot, 'data', 'raw', 'seeds')
export const seedsDir = join(repoRoot, 'data', 'seeds')
mkdirSync(rawDir, { recursive: true })
mkdirSync(seedsDir, { recursive: true })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function getBytes(url: string, init: RequestInit = {}, tries = 4): Promise<Buffer> {
  let last: unknown
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(120_000),
        headers: { 'user-agent': USER_AGENT, ...(init.headers as Record<string, string>) },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      last = err
      await sleep(1000 * 2 ** i)
    }
  }
  throw last
}

// downloads once into data/raw/seeds; reruns read the file
export async function cached(name: string, url: string): Promise<Buffer> {
  const p = join(rawDir, name)
  if (existsSync(p)) return readFileSync(p)
  console.log(`downloading ${url}`)
  const buf = await getBytes(url)
  writeFileSync(p, buf)
  return buf
}

export async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  return JSON.parse((await getBytes(url, init)).toString('utf8')) as T
}

export function writeSeed(name: string, data: unknown) {
  const p = join(seedsDir, name)
  writeFileSync(p, typeof data === 'string' || Buffer.isBuffer(data) ? data : `${JSON.stringify(data)}\n`)
  console.log(`wrote data/seeds/${name}`)
}

export const pause = sleep
