import { describe, expect, it, vi } from 'vitest'
import type { HazardEvent } from '@sentinel/shared'
import { clusterFires } from '../src/feeds/sources.ts'
import { matchesGdacs, tierQuake } from '../src/feeds/watcher.ts'
import { makeDeps } from './helpers.ts'

const quake = (over: Partial<HazardEvent> = {}): HazardEvent => ({
  id: 'usgs:us1',
  type: 'earthquake',
  title: 'M 6.1 - somewhere',
  geometry: { type: 'Point', coordinates: [140, 36] },
  severity: { mag: 6.1, depth_km: 10, origin_time: '2026-09-16T10:00:00.000Z' },
  sources: [{ name: 'USGS', id: 'us1' }],
  detected_at: 'now',
  ingested_at: 'now',
  tier: 0,
  status: 'watch',
  is_drill: false,
  ...over,
})

describe('tierQuake', () => {
  it('needs a second source', () => {
    expect(tierQuake({ mag: 7, felt: 0, gdacsMatch: false, strongShaking: 1e6 }, 10_000).tier).toBe(0)
  })

  it('counts felt reports', () => {
    expect(tierQuake({ mag: 5, felt: 40, gdacsMatch: false, strongShaking: 100 }, 10_000).tier).toBe(1)
  })

  it('acts on big exposed quakes', () => {
    const t = tierQuake({ mag: 6.2, felt: 0, gdacsMatch: true, strongShaking: 250_000 }, 10_000)
    expect(t).toMatchObject({ tier: 2 })
    expect(t.reason).not.toMatch(/\d{3,}/)
  })
})

describe('matchesGdacs', () => {
  const g = (over: { at?: number; lon?: number; mag?: number } = {}) => ({
    alert: 'Orange' as const,
    magnitude: over.mag ?? 6.0,
    at: over.at ?? Date.parse('2026-09-16T10:00:40Z'),
    event: quake({ id: 'gdacs:EQ:1', geometry: { type: 'Point', coordinates: [over.lon ?? 140.3, 36] } }),
  })

  it('pairs the same quake', () => {
    expect(matchesGdacs(quake(), g())).toBe(true)
  })

  it('rejects distant or late ones', () => {
    expect(matchesGdacs(quake(), g({ lon: 143 }))).toBe(false)
    expect(matchesGdacs(quake(), g({ at: Date.parse('2026-09-16T10:09:00Z') }))).toBe(false)
    expect(matchesGdacs(quake(), g({ mag: 5.2 }))).toBe(false)
  })
})

describe('clusterFires', () => {
  it('groups nearby detections', () => {
    const p = (lat: number, lon: number) => ({ lat, lon, frp: 5, at: '2026-09-16T01:00:00Z' })
    const clusters = clusterFires([p(40, -120), p(40.01, -120), p(40.02, -120.01), p(45, -110), p(45.001, -110)])
    expect(clusters).toHaveLength(1)
    expect(clusters[0]).toHaveLength(3)
  })
})

describe('feed watcher', () => {
  it('holds live runs during drills', async () => {
    vi.resetModules()
    vi.doMock('../src/feeds/sources.ts', async (orig) => ({
      ...(await orig<typeof import('../src/feeds/sources.ts')>()),
      usgsRecent: async () => [{ event: quake(), updated: 1, detailUrl: 'x', felt: 50 }],
      usgsPagerExposure: async () => ({ byMmi: [0, 0, 0, 0, 0, 90_000, 60_000, 0, 0, 0], alert: 'orange' }),
    }))
    const { FeedWatcher } = await import('../src/feeds/watcher.ts')
    const d = makeDeps()
    const begun: string[] = []
    const w = new FeedWatcher({ chain: d.chain, switches: d.switches, minPop: 10_000, begin: (e) => begun.push(e.id) })
    await w.usgs()
    expect(begun).toHaveLength(0)
    expect(d.chain.after(0).map((e) => e.kind)).toEqual(['event.detected', 'event.tiered', 'note'])
    vi.doUnmock('../src/feeds/sources.ts')
  })
})
