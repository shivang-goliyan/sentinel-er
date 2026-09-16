// emPOWER snapshot for every ZCTA within 80 km of the drill epicentre, so the drill still works if
// the HHS service is down. The live query is in apps/core/src/context/empower.ts.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMPOWER_FIELDS, EMPOWER_LAYER } from '../../apps/core/src/context/empower.ts'
import { haversineKm } from '../../apps/core/src/geo/seeds.ts'
import { DEFAULT_DRILL } from '../../apps/core/src/modes/drill-point.ts'
import { getJson, pause, seedsDir, writeSeed } from './lib.ts'

const RADIUS_KM = 80
const zcta = JSON.parse(readFileSync(join(seedsDir, 'zcta-2020.json'), 'utf8')) as { rows: [string, number, number][] }
const zips = zcta.rows.filter(([, lon, lat]) => haversineKm(DEFAULT_DRILL.lon, DEFAULT_DRILL.lat, lon, lat) <= RADIUS_KM).map(([z]) => z)

const rows: Record<string, unknown>[] = []
for (let i = 0; i < zips.length; i += 100) {
  const part = zips.slice(i, i + 100)
  const q = new URLSearchParams({
    where: `Zip_Code IN (${part.map((z) => `'${z}'`).join(',')})`,
    outFields: EMPOWER_FIELDS.join(','),
    returnGeometry: 'false',
    f: 'json',
  })
  const body = await getJson<{ features?: { attributes: Record<string, unknown> }[]; error?: { message: string } }>(
    `${EMPOWER_LAYER}/query`,
    { method: 'POST', body: q, headers: { 'content-type': 'application/x-www-form-urlencoded' } },
  )
  if (body.error) throw new Error(body.error.message)
  rows.push(...(body.features ?? []).map((f) => f.attributes))
  await pause(400)
}

writeSeed('empower-drill-region.json', {
  source: EMPOWER_LAYER,
  retrieved_at: new Date().toISOString(),
  note: `ZCTAs within ${RADIUS_KM} km of the drill epicentre; HHS publishes counts of 1-10 as 11`,
  zctas_asked: zips.length,
  rows,
})
console.log(`${zips.length} ZCTAs asked, ${rows.length} rows back`)
