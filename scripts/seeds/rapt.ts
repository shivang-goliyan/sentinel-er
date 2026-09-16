// FEMA Hospitals RAPT layer (the public copy of HIFLD hospitals). Default: VA, DC and MD.
// `--all` pulls every state (run it on the server; the output is ~2 MB and isn't committed).
import { getJson, pause, writeSeed } from './lib.ts'

const LAYER = 'https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/Hospitals_RAPT/FeatureServer/6'
const FIELDS = [
  'ID', 'NAME', 'ADDRESS', 'CITY', 'STATE', 'ZIP', 'TELEPHONE', 'TYPE', 'STATUS', 'COUNTY',
  'LATITUDE', 'LONGITUDE', 'WEBSITE', 'OWNER', 'BEDS', 'TRAUMA', 'HELIPAD', 'SOURCE', 'SOURCEDATE', 'VAL_DATE',
]

const all = process.argv.includes('--all')
const where = all ? '1=1' : "STATE IN ('VA','DC','MD')"

type Page = { features: { attributes: Record<string, unknown> }[]; exceededTransferLimit?: boolean }
const rows: Record<string, unknown>[] = []
for (let offset = 0; ; offset += 2000) {
  const q = new URLSearchParams({
    where,
    outFields: FIELDS.join(','),
    returnGeometry: 'false',
    orderByFields: 'FID',
    resultOffset: String(offset),
    resultRecordCount: '2000',
    f: 'json',
  })
  const page = await getJson<Page>(`${LAYER}/query?${q}`)
  for (const f of page.features) {
    const a = { ...f.attributes }
    for (const k of ['SOURCEDATE', 'VAL_DATE']) {
      if (typeof a[k] === 'number') a[k] = new Date(a[k] as number).toISOString().slice(0, 10)
    }
    if (a.BEDS === -999) a.BEDS = null
    rows.push(a)
  }
  if (!page.exceededTransferLimit && page.features.length < 2000) break
  await pause(500)
}

writeSeed(all ? 'hospitals-rapt-us.json' : 'hospitals-rapt-va-dc-md.json', {
  source: `${LAYER} (licence: Public Use)`,
  retrieved_at: new Date().toISOString(),
  where,
  rows,
})
console.log(`${rows.length} hospitals`)
