// Census 2020 block-group centres of population, national, packed as float32 (lon, lat, pop) triples.
// ~240k rows → a few MB, small enough to commit.
import { cached, writeSeed } from './lib.ts'

const URL = 'https://www2.census.gov/geo/docs/reference/cenpop2020/blkgrp/CenPop2020_Mean_BG.txt'

const text = (await cached('CenPop2020_Mean_BG.txt', URL)).toString('utf8').replace(/^﻿/, '')
const lines = text.split(/\r?\n/)
const header = lines[0]!.split(',').map((h) => h.trim())
const iPop = header.indexOf('POPULATION')
const iLat = header.indexOf('LATITUDE')
const iLon = header.indexOf('LONGITUDE')
if (iPop < 0 || iLat < 0 || iLon < 0) throw new Error(`unexpected header: ${header.join(',')}`)

const out: number[] = []
let people = 0
for (const line of lines.slice(1)) {
  if (!line.trim()) continue
  const cols = line.split(',')
  const pop = Number(cols[iPop])
  if (!pop) continue
  out.push(Number(cols[iLon]), Number(cols[iLat]), pop)
  people += pop
}
const packed = Buffer.from(new Float32Array(out).buffer)
writeSeed('blockgroups-2020.f32', packed)
writeSeed('blockgroups-2020.json', {
  source: URL,
  layout: 'float32 little-endian triples: lon, lat, population',
  rows: out.length / 3,
  population: people,
})
console.log(`${(out.length / 3).toLocaleString()} block groups, ${people.toLocaleString()} people`)
