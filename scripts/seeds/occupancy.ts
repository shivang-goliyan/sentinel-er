// Facility occupancy baseline: each hospital's own average over its last reported year
// (HHS facility capacity data, which stopped in April 2024), plus the national figure then and now
// (CDC NHSN) so the baseline can be scaled to today.
// Run: node scripts/seeds/occupancy.ts [--all]
import { getJson, writeSeed } from './lib.ts'

const FROM = '2023-04-23'
const TO = '2024-04-21'
const all = process.argv.includes('--all')
const states = all ? null : ['VA', 'DC', 'MD']

type Row = { hospital_pk: string; hospital_name: string; city: string; zip: string; state: string; used: string; beds: string; weeks: string }

function soql(base: string, params: Record<string, string>) {
  const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [`$${k}`, v]))
  return `${base}?${q}`
}

const where = [
  states ? `state in(${states.map((s) => `'${s}'`).join(',')})` : null,
  `collection_week between '${FROM}' and '${TO}'`,
  'inpatient_beds_used_7_day_avg > 0',
  'total_beds_7_day_avg > 0',
]
  .filter(Boolean)
  .join(' AND ')

const rows: Row[] = []
for (let offset = 0; ; offset += 5000) {
  const page = await getJson<Row[]>(
    soql('https://healthdata.gov/resource/anag-cw7u.json', {
      select:
        'hospital_pk,hospital_name,city,zip,state,avg(inpatient_beds_used_7_day_avg) as used,avg(total_beds_7_day_avg) as beds,count(*) as weeks',
      where,
      group: 'hospital_pk,hospital_name,city,zip,state',
      order: 'hospital_pk',
      limit: '5000',
      offset: String(offset),
    }),
  )
  rows.push(...page)
  if (page.length < 5000) break
}

const [then] = await getJson<{ occ: string; n: string }[]>(
  soql('https://data.cdc.gov/resource/ua7e-t2fy.json', {
    select: 'avg(pctinptbedsocc) as occ,count(*) as n',
    where: `jurisdiction='USA' AND weekendingdate between '${FROM}' and '2024-04-27'`,
  }),
)
const [now] = await getJson<{ weekendingdate: string; pctinptbedsocc: string }[]>(
  soql('https://data.cdc.gov/resource/ua7e-t2fy.json', {
    select: 'weekendingdate,pctinptbedsocc',
    where: "jurisdiction='USA' AND pctinptbedsocc IS NOT NULL",
    order: 'weekendingdate DESC',
    limit: '1',
  }),
)

const kept = rows
  .map((r) => ({
    ccn: r.hospital_pk,
    name: r.hospital_name,
    city: r.city,
    zip: String(r.zip ?? '').slice(0, 5),
    state: r.state,
    beds: Math.round(Number(r.beds)),
    // a hospital can report more patients than its bed average in a week; cap it
    occupancy: Math.min(1, Number(r.used) / Number(r.beds)),
    weeks: Number(r.weeks),
  }))
  .filter((r) => r.weeks >= 4 && Number.isFinite(r.occupancy))

writeSeed(all ? 'occupancy-hhs-us.json' : 'occupancy-hhs-va-dc-md.json', {
  source: 'HHS COVID-19 Reported Patient Impact and Hospital Capacity by Facility (healthdata.gov anag-cw7u)',
  url: 'https://healthdata.gov/resource/anag-cw7u.json',
  window: { from: FROM, to: TO },
  national: {
    source: 'CDC NHSN Weekly Hospital Respiratory Data (data.cdc.gov ua7e-t2fy)',
    url: 'https://data.cdc.gov/resource/ua7e-t2fy.json',
    then: Number(then!.occ) / 100,
    now: Number(now!.pctinptbedsocc) / 100,
    now_week: now!.weekendingdate.slice(0, 10),
  },
  retrieved_at: new Date().toISOString(),
  rows: kept,
})
console.log(`${kept.length} hospitals kept of ${rows.length}; national ${then!.occ}% then, ${now!.pctinptbedsocc}% now`)
