import type { HazardEvent } from '@sentinel/shared'
import type { LogChain } from '../log/chain.ts'
import type { Switches } from '../switches.ts'
import {
  eonetOpen,
  firmsClusters,
  gdacsCurrent,
  nwsSevere,
  swpcStorms,
  usgsPagerExposure,
  usgsRecent,
  type GdacsItem,
  type PagerExposure,
} from './sources.ts'

export interface QuakeEvidence {
  mag: number
  felt: number
  gdacsMatch: boolean
  // people at shaking VI and above, from USGS PAGER
  strongShaking: number | null
}

export interface Tiering {
  tier: 0 | 1 | 2
  reason: string
}

// Tier 1 needs a second, independent source; tier 2 also needs size and people in the way.
export function tierQuake(e: QuakeEvidence, minPop: number, minMag = 5.5): Tiering {
  const second = e.gdacsMatch ? 'GDACS' : e.felt >= 10 ? `${e.felt} felt reports` : null
  if (!second) return { tier: 0, reason: 'USGS only so far' }
  const enough = e.mag >= minMag && (e.strongShaking ?? 0) >= minPop
  if (!enough) {
    return {
      tier: 1,
      reason: `USGS + ${second}; ${e.strongShaking === null ? 'no exposure estimate yet' : 'below the action threshold'}`,
    }
  }
  return { tier: 2, reason: `USGS + ${second}; M${e.mag.toFixed(1)} with people in strong shaking` }
}

const km = (a: [number, number], b: [number, number]) =>
  Math.hypot((a[1] - b[1]) * 111, (a[0] - b[0]) * 111 * Math.cos((a[1] * Math.PI) / 180))

export function matchesGdacs(quake: HazardEvent, g: GdacsItem): boolean {
  if (g.event.type !== 'earthquake' || g.magnitude === null) return false
  const s = quake.severity as { mag: number; origin_time: string }
  const q = quake.geometry.coordinates as [number, number]
  const p = g.event.geometry.coordinates as [number, number]
  return Math.abs(Date.parse(s.origin_time) - g.at) <= 120_000 && km(q, p) <= 100 && Math.abs(s.mag - g.magnitude) <= 0.4
}

type SourceName = 'usgs' | 'gdacs' | 'eonet' | 'swpc' | 'nws' | 'firms'
const EVERY: Record<SourceName, number> = {
  usgs: 60_000,
  gdacs: 5 * 60_000,
  eonet: 15 * 60_000,
  swpc: 60_000,
  nws: 2 * 60_000,
  firms: 10 * 60_000,
}
// continental US, where the hospital and power-dependent data apply
const US_BOX: [number, number, number, number] = [-125, 24, -66, 50]

export interface WatcherDeps {
  chain: LogChain
  switches: Switches
  minPop: number
  begin: (event: HazardEvent) => void
}

export class FeedWatcher {
  private d: WatcherDeps
  private timers: ReturnType<typeof setInterval>[] = []
  private quakes = new Map<string, { updated: number; tier: number; started: boolean }>()
  private logged = new Set<string>()
  private gdacsItems: GdacsItem[] = []
  readonly health: Partial<Record<SourceName, { ok_at?: string; error?: string; items?: number }>> = {}

  constructor(d: WatcherDeps) {
    this.d = d
  }

  start() {
    for (const name of Object.keys(EVERY) as SourceName[]) {
      const run = () => void this.tick(name)
      setTimeout(run, Math.random() * 5_000)
      this.timers.push(setInterval(run, EVERY[name] + Math.random() * 3_000))
    }
  }

  stop() {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }

  async tick(name: SourceName) {
    try {
      const n = await this[name]()
      this.health[name] = { ok_at: new Date().toISOString(), items: n }
    } catch (err) {
      this.health[name] = { ...this.health[name], error: (err as Error).message }
    }
  }

  private once(event: HazardEvent, tier: 0 | 1 | 2 = 0, reason = 'single source') {
    if (this.logged.has(event.id)) return false
    this.logged.add(event.id)
    this.d.chain.append('feeds', 'event.detected', { event: { ...event, tier } }, null)
    this.d.chain.append('feeds', 'event.tiered', { event_id: event.id, tier, reason }, null)
    return true
  }

  async usgs(): Promise<number> {
    const quakes = await usgsRecent(4.5, 'all_hour')
    for (const q of quakes) {
      const known = this.quakes.get(q.event.id)
      if (known && known.updated === q.updated) continue
      const mag = (q.event.severity as { mag: number }).mag
      let exposure: PagerExposure | null = null
      if (mag >= 5) exposure = await usgsPagerExposure(q.detailUrl).catch(() => null)
      const strong = exposure ? exposure.byMmi.slice(5).reduce((a, b) => a + b, 0) : null
      const t = tierQuake(
        { mag, felt: q.felt, gdacsMatch: this.gdacsItems.some((g) => matchesGdacs(q.event, g)), strongShaking: strong },
        this.d.minPop,
      )
      const event: HazardEvent = {
        ...q.event,
        tier: t.tier,
        severity: { ...q.event.severity, pager_alert: exposure?.alert ?? (q.event.severity as { pager_alert: string | null }).pager_alert, strong_shaking_pop: strong },
      }
      if (!known) {
        this.logged.add(event.id)
        this.d.chain.append('feeds', 'event.detected', { event }, null)
        this.d.chain.append('feeds', 'event.tiered', { event_id: event.id, tier: t.tier, reason: t.reason }, null)
      } else if (known.tier !== t.tier) {
        this.d.chain.append('feeds', 'event.tiered', { event_id: event.id, tier: t.tier, reason: t.reason }, null)
      }
      const started = known?.started ?? false
      this.quakes.set(event.id, { updated: q.updated, tier: t.tier, started })
      if (t.tier === 2 && !started) {
        if (this.d.switches.drill) {
          if (!known || known.tier !== 2) {
            this.d.chain.append('orchestrator', 'note', { text: `${event.title} reached tier 2, but drill mode is on, so no live run started` }, null)
          }
        } else {
          this.quakes.set(event.id, { updated: q.updated, tier: 2, started: true })
          this.d.begin({ ...event, status: 'active' })
        }
      }
    }
    return quakes.length
  }

  async gdacs(): Promise<number> {
    this.gdacsItems = await gdacsCurrent()
    for (const g of this.gdacsItems) {
      if (g.event.type === 'earthquake' || g.alert === 'Green') continue
      this.once(g.event, 1, `GDACS ${g.alert} alert`)
    }
    return this.gdacsItems.length
  }

  async eonet(): Promise<number> {
    const events = (await eonetOpen(2)).filter((e) => e.type !== 'wildfire')
    for (const e of events) this.once(e, 0, 'NASA EONET only')
    return events.length
  }

  async swpc(): Promise<number> {
    const storms = await swpcStorms()
    for (const s of storms) this.once(s, 1, 'NOAA SWPC alert at G3 or above')
    return storms.length
  }

  async nws(): Promise<number> {
    const alerts = await nwsSevere()
    for (const a of alerts) this.once(a, 1, 'NWS warning, severe and immediate')
    return alerts.length
  }

  async firms(): Promise<number> {
    const fires = await firmsClusters(US_BOX)
    for (const f of fires) {
      if (f.count >= 10) this.once(f.event, 1, `${f.count} satellite fire detections in one cluster`)
    }
    return fires.length
  }
}
