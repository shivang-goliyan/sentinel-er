import type Database from 'better-sqlite3'
import { maskPhone } from '@sentinel/shared'
import type { LogChain } from '../log/chain.ts'

// Who a drill call may reach. 'handoff' is the person red-flag calls are passed to.
export const WHITELIST_ROLES = ['charge_nurse', 'lifeline_county', 'lifeline_dme', 'switchboard', 'handoff', 'test'] as const
export type WhitelistRole = (typeof WHITELIST_ROLES)[number]

interface Row {
  e164: string
  label: string
  role: string
  consent_at: string
  consent_by: string
}

export class NotWhitelisted extends Error {}

export function normaliseE164(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '')
  const withPlus = digits.startsWith('+') ? digits : digits.length === 10 ? `+1${digits}` : `+${digits}`
  return /^\+[1-9]\d{7,14}$/.test(withPlus) ? withPlus : null
}

export class Whitelist {
  private sqlite: Database.Database
  private chain: LogChain

  constructor(sqlite: Database.Database, chain: LogChain) {
    this.sqlite = sqlite
    this.chain = chain
  }

  add(raw: string, label: string, role: WhitelistRole, consentBy: string) {
    const e164 = normaliseE164(raw)
    if (!e164) throw new Error("That doesn't look like a phone number.")
    if (this.isHospitalNumber(e164)) throw new Error('That number belongs to a hospital profile. Hospitals are never called.')
    this.sqlite
      .prepare(
        `INSERT INTO whitelist (e164, label, role, consent_at, consent_by) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(e164) DO UPDATE SET label = excluded.label, role = excluded.role,
           consent_at = excluded.consent_at, consent_by = excluded.consent_by`,
      )
      .run(e164, label, role, new Date().toISOString(), consentBy)
    this.chain.append('operator', 'whitelist.changed', { label, role, masked: maskPhone(e164) })
    return e164
  }

  remove(raw: string) {
    const e164 = normaliseE164(raw)
    if (!e164) return false
    const row = this.sqlite.prepare<[string], Row>('SELECT * FROM whitelist WHERE e164 = ?').get(e164)
    if (!row) return false
    this.sqlite.prepare('DELETE FROM whitelist WHERE e164 = ?').run(e164)
    this.chain.append('operator', 'whitelist.changed', {
      label: row.label,
      role: row.role,
      masked: maskPhone(e164),
      removed: true,
    })
    return true
  }

  has(raw: string): boolean {
    const e164 = normaliseE164(raw)
    return Boolean(e164 && this.sqlite.prepare('SELECT 1 FROM whitelist WHERE e164 = ?').get(e164))
  }

  numberFor(role: WhitelistRole): { e164: string; label: string } | null {
    const row = this.sqlite
      .prepare<[string], Row>('SELECT * FROM whitelist WHERE role = ? ORDER BY consent_at DESC LIMIT 1')
      .get(role)
    return row ? { e164: row.e164, label: row.label } : null
  }

  list() {
    return this.sqlite
      .prepare<[], Row>('SELECT * FROM whitelist ORDER BY role, label')
      .all()
      .map((r) => ({ masked: maskPhone(r.e164), label: r.label, role: r.role, consent_at: r.consent_at }))
  }

  // belt and braces: a number that shows up anywhere in a hospital profile can't be whitelisted
  private isHospitalNumber(e164: string): boolean {
    const tail = e164.slice(-10)
    const rows = this.sqlite
      .prepare<[], { v: string | null }>(
        `SELECT phone_main AS v FROM hospitals UNION ALL SELECT phone_er FROM hospitals
         UNION ALL SELECT value FROM hospital_fields WHERE field LIKE '%phone%'`,
      )
      .all()
    return rows.some((r) => r.v !== null && String(r.v).replace(/\D/g, '').endsWith(tail))
  }
}
