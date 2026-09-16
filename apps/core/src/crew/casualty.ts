import type { FactSource } from '@sentinel/shared'
import type { FactStore } from '../facts/store.ts'
import type { LogChain } from '../log/chain.ts'

export interface CasualtyInput {
  popMmi: Record<number, number>
  magnitude: number
  depthKm: number
  localHour: number | null
  iso3?: string
  iso2?: string
}

interface Band {
  p10: number
  p50: number
  p90: number
}

export interface CasualtyOut {
  deaths: Band
  injured: Band
  explain: { prior_log1p: number; contributions: { feature: string; contribution_log1p: number; value: number | null }[] }
  country: { iso3: string; name: string; region: string }
  prior_deaths: number
  model: { variant: string; trained_rows: number | null }
}

export type Planning = 'p50' | 'p90'

// Hour of day where the quake happened; people indoors at night changes the toll.
export function localHour(isoTime: string, tz: string | undefined, lon: number): number {
  const t = new Date(isoTime)
  if (tz) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(t)
    const n = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0)
    return n('hour') + n('minute') / 60
  }
  // no zone known: solar time from longitude is close enough for day versus night
  return (((t.getUTCHours() + t.getUTCMinutes() / 60 + lon / 15) % 24) + 24) % 24
}

const LABEL: Record<keyof Band, string> = { p10: 'low estimate', p50: 'middle estimate', p90: 'high estimate' }

export async function callCasualtyModel(input: CasualtyInput, scienceUrl: string): Promise<CasualtyOut> {
  const res = await fetch(`${scienceUrl}/casualty`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      pop_mmi: Object.fromEntries(Object.entries(input.popMmi).map(([k, v]) => [String(k), v])),
      magnitude: input.magnitude,
      depth_km: input.depthKm,
      local_hour: input.localHour,
      iso3: input.iso3,
      iso2: input.iso2,
    }),
  })
  if (!res.ok) throw new Error(`science service said ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as CasualtyOut
}

export async function runCasualtyStage(
  d: { chain: LogChain; facts: FactStore },
  runId: string,
  input: CasualtyInput,
  scienceUrl: string,
  planning: Planning,
): Promise<CasualtyOut | null> {
  const { chain, facts } = d
  chain.append('analyst', 'status', { text: 'Running the casualty model on the exposure' }, runId)
  let out: CasualtyOut
  try {
    out = await callCasualtyModel(input, scienceUrl)
  } catch (err) {
    const message = (err as Error).message
    chain.append('analyst', 'error', { where: 'casualty model', message }, runId)
    chain.append('analyst', 'status', { text: `Casualty model unavailable: ${message}`, state: 'error' }, runId)
    return null
  }

  const source: FactSource = {
    name: `Sentinel casualty model (LightGBM quantiles on a PAGER-style prior, ${out.model.variant}); screening estimate`,
    url: 'https://github.com/shivang-goliyan/sentinel-er/tree/main/ml/casualty',
    retrieved_at: new Date().toISOString(),
    method: 'model',
  }
  for (const target of ['deaths', 'injured'] as const) {
    const noun = target === 'deaths' ? 'Deaths' : 'Injured'
    for (const q of ['p10', 'p50', 'p90'] as const) {
      facts.add(runId, { key: `casualty.${target}.${q}`, label: `${noun}, ${LABEL[q]}`, value: out[target][q], unit: 'people', source })
    }
    facts.add(runId, {
      key: `casualty.${target}.planning`,
      label: `${noun}, planning figure${planning === 'p90' ? ' (high end of the range)' : ''}`,
      value: out[target][planning],
      unit: 'people',
      source,
    })
  }
  chain.append('analyst', 'model.output', { model: 'casualty', version: out.model.variant, outputs: { ...out, planning } }, runId)
  chain.append('analyst', 'ledger', { milestone: 'casualties_estimated' }, runId)
  chain.append(
    'analyst',
    'status',
    {
      text: `Screening estimate: ${out.injured.p10.toLocaleString('en-US')} to ${out.injured.p90.toLocaleString('en-US')} injured; planning on ${out.injured[planning].toLocaleString('en-US')}`,
      state: 'done',
    },
    runId,
  )
  return out
}
