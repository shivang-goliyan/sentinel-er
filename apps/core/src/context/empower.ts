import { tapedFetch } from '../tape.ts'
import { readSeedIfThere } from '../geo/seeds.ts'

export const EMPOWER_LAYER =
  'https://services2.arcgis.com/ZQ4jTQn6k7VPXEwO/arcgis/rest/services/HHS_emPOWER_REST_Service_Public/FeatureServer/1'

export const DEVICE_FIELDS = [
  'Ventilators_13mo',
  'BiPAPs_13mo',
  'O2_Concentrators_36mo',
  'Enteral_Feeding_13mo',
  'IV_Infusion_Pumps_13mo',
  'Suction_Pumps_13mo',
  'AtHome_Dialysis_3mo',
  'Power_Wheelchairs_Scooters_13mo',
  'Electric_Beds_13mo',
] as const

export const EMPOWER_FIELDS = ['Zip_Code', 'STATE', 'COUNTY', 'FIPS_Code', 'Medicare_Benes', 'Power_Dependent_Devices_DME', ...DEVICE_FIELDS]

export interface EmpowerRow {
  zip: string
  state: string | null
  county: string | null
  medicare_benes: number | null
  power_dependent: number | null
  devices: Partial<Record<(typeof DEVICE_FIELDS)[number], number | null>>
}

// HHS publishes counts of 1–10 as 11
export const MASKED = 11
export const isMasked = (n: number | null | undefined) => n === MASKED

function toRow(a: Record<string, unknown>): EmpowerRow {
  const num = (v: unknown) => (typeof v === 'number' ? v : v == null || v === '' ? null : Number(v))
  const devices: EmpowerRow['devices'] = {}
  for (const f of DEVICE_FIELDS) devices[f] = num(a[f])
  return {
    zip: String(a.Zip_Code ?? '').trim().padStart(5, '0'),
    state: (a.STATE as string | undefined)?.trim() ?? null,
    county: (a.COUNTY as string | undefined)?.trim() ?? null,
    medicare_benes: num(a.Medicare_Benes),
    power_dependent: num(a.Power_Dependent_Devices_DME),
    devices,
  }
}

export interface EmpowerResult {
  rows: Map<string, EmpowerRow>
  source: 'live' | 'tape' | 'seed'
  url: string
}

type Seed = { retrieved_at: string; rows: Record<string, unknown>[] }
let seedRows: Map<string, EmpowerRow> | null = null
function seed(): Map<string, EmpowerRow> {
  if (!seedRows) {
    const s = readSeedIfThere<Seed>('empower-drill-region.json')
    seedRows = new Map((s?.rows ?? []).map((a) => [toRow(a).zip, toRow(a)]))
  }
  return seedRows
}

export async function fetchEmpower(zips: string[], chunk = 100): Promise<EmpowerResult> {
  const rows = new Map<string, EmpowerRow>()
  let source: EmpowerResult['source'] = 'live'
  const wanted = [...new Set(zips)].filter((z) => /^\d{5}$/.test(z))
  for (let i = 0; i < wanted.length; i += chunk) {
    const part = wanted.slice(i, i + chunk)
    const q = new URLSearchParams({
      where: `Zip_Code IN (${part.map((z) => `'${z}'`).join(',')})`,
      outFields: EMPOWER_FIELDS.join(','),
      returnGeometry: 'false',
      f: 'json',
    })
    try {
      const res = await tapedFetch('empower', `${EMPOWER_LAYER}/query?${q}`, { timeoutMs: 20_000 })
      const body = res.json<{ features?: { attributes: Record<string, unknown> }[]; error?: { message: string } }>()
      if (body.error || !body.features) throw new Error(body.error?.message ?? 'no features')
      if (res.fromTape) source = 'tape'
      for (const f of body.features) {
        const r = toRow(f.attributes)
        rows.set(r.zip, r)
      }
    } catch {
      source = 'seed'
      for (const z of part) {
        const r = seed().get(z)
        if (r) rows.set(z, r)
      }
    }
  }
  return { rows, source, url: EMPOWER_LAYER }
}
