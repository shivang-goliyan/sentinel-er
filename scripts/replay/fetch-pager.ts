// Saves the FIRST exposure estimate USGS published for each replay scenario, so a rerun can show
// what the model would have said at that moment. Run: node scripts/replay/fetch-pager.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from '../../apps/core/src/config.ts'
import { getBytes, getJson } from '../seeds/lib.ts'

const SCENARIOS = [
  { name: 'turkey-2023', eventId: 'us6000jllz', iso3: 'TUR', tz: 'Europe/Istanbul' },
  { name: 'nepal-2015', eventId: 'us20002926', iso3: 'NPL', tz: 'Asia/Kathmandu' },
  { name: 'mineral-va-2011', eventId: 'se609212', iso3: 'USA', tz: 'America/New_York' },
]

type Product = { updateTime: number; properties: Record<string, string>; contents: Record<string, { url: string }> }

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null

for (const s of SCENARIOS) {
  const detail = await getJson<{
    properties: { time: number; title: string; mag: number; products: Record<string, Product[]> }
    geometry: { coordinates: [number, number, number] }
  }>(`https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=${s.eventId}&format=geojson&includesuperseded=true`)
  const versions = (detail.properties.products.losspager ?? [])
    .filter((v) => v.contents['pager.xml'])
    .sort((a, b) => a.updateTime - b.updateTime)
  if (!versions.length) {
    console.log(`${s.name}: no PAGER product, skipped`)
    continue
  }
  for (const [which, first] of [['first', versions[0]!], ['final', versions.at(-1)!]] as const) {
  const xml = (await getBytes(first.contents['pager.xml']!.url)).toString('utf8')
  const event = xml.match(/<event [^>]+>/)?.[0] ?? ''
  const pop: Record<string, number> = {}
  for (const m of xml.matchAll(/<exposure dmin="([\d.]+)" dmax="([\d.]+)" exposure="(\d+)"/g)) {
    // bins are centred on whole intensities: 6.5–7.5 is level VII
    pop[String(Math.round((Number(m[1]) + Number(m[2])) / 2))] = Number(m[3])
  }
  const origin = detail.properties.time
  const out = {
    scenario: s.name,
    event_id: s.eventId,
    title: detail.properties.title,
    origin_time: new Date(origin).toISOString(),
    final_magnitude: detail.properties.mag,
    published_at: new Date(first.updateTime).toISOString(),
    minutes_after_origin: Math.round((first.updateTime - origin) / 60_000),
    pager_xml: first.contents['pager.xml']!.url,
    alert: first.properties.alertlevel ?? null,
    magnitude: Number(attr(event, 'magnitude')),
    depth_km: Number(attr(event, 'depth')),
    lat: Number(attr(event, 'lat')),
    lon: Number(attr(event, 'lon')),
    maxmmi: Number(attr(event, 'maxmmi')),
    local_time: attr(event, 'localtime'),
    pop_mmi: pop,
    iso3: s.iso3,
    tz: s.tz,
    versions: versions.length,
  }
  const dir = join(repoRoot, 'replay', s.name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `pager-${which}.json`), `${JSON.stringify(out, null, 2)}\n`)
  console.log(`${s.name}: ${which} estimate ${out.minutes_after_origin} min after origin, M${out.magnitude}, ${Object.keys(pop).length} bins`)
  }
}
