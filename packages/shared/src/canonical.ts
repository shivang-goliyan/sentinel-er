// The server and the browser both hash this exact string, so it can't depend on the order keys
// were inserted in. Keys are sorted at every depth and undefined values are dropped.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : sortDeep(x)))
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k]
      if (x !== undefined) out[k] = sortDeep(x)
    }
    return out
  }
  return v
}

export const GENESIS_HASH = '0'.repeat(64)

export interface HashableEntry {
  seq: number
  ts: string
  run_id: string | null
  actor: string
  kind: string
  payload: unknown
}

export function hashMaterial(prevHash: string, e: HashableEntry): string {
  return prevHash + canonicalJson({
    seq: e.seq,
    ts: e.ts,
    run_id: e.run_id,
    actor: e.actor,
    kind: e.kind,
    payload: e.payload,
  })
}

// Browser-side (and test-side) hashing. The server uses node:crypto so appends stay synchronous.
export async function sha256Hex(text: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '')
  return digits.length < 4 ? '••••' : `••• ••• ${digits.slice(-4)}`
}
