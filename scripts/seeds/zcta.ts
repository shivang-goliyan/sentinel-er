// 2020 ZCTA gazetteer → internal points only.
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cached, rawDir, writeSeed } from './lib.ts'

const URL = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_zcta_national.zip'

const txt = join(rawDir, '2020_Gaz_zcta_national.txt')
if (!existsSync(txt)) {
  const zip = await cached('2020_Gaz_zcta_national.zip', URL)
  const zipPath = join(rawDir, '2020_Gaz_zcta_national.zip')
  writeFileSync(zipPath, zip)
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', rawDir])
}

const { readFileSync } = await import('node:fs')
const lines = readFileSync(txt, 'utf8').split(/\r?\n/)
const header = lines[0]!.split('\t').map((h) => h.trim())
const iId = header.indexOf('GEOID')
const iLat = header.indexOf('INTPTLAT')
const iLon = header.indexOf('INTPTLONG')
if (iId < 0 || iLat < 0 || iLon < 0) throw new Error(`unexpected header: ${header.join('|')}`)

const rows: [string, number, number][] = []
for (const line of lines.slice(1)) {
  if (!line.trim()) continue
  const c = line.split('\t')
  rows.push([c[iId]!.trim(), Number(Number(c[iLon]).toFixed(5)), Number(Number(c[iLat]).toFixed(5))])
}
writeSeed('zcta-2020.json', { source: URL, columns: ['zcta', 'lon', 'lat'], rows })
console.log(`${rows.length.toLocaleString()} ZCTAs`)
