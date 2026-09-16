import { randomBytes } from 'node:crypto'
import { MAX_LAYER_BYTES, type Actor, type FactSource, type HazardEvent, type RunMode } from '@sentinel/shared'
import type { Deps } from '../server.ts'
import { careHomesFromOsm, CMS_FACILITIES_STATUS } from '../context/facilities.ts'
import { fetchEmpower, isMasked, EMPOWER_LAYER, type EmpowerRow } from '../context/empower.ts'
import { hospitalsNear, raptSeed, saveProfiles, traumaLabel, RAPT_SOURCE, RAPT_URL } from '../context/hospitals.ts'
import { fetchPois, type Poi } from '../context/overpass.ts'
import { voltageClass } from '../geo/fragility.ts'
import { exposureByBand, BANDS } from '../geo/population.ts'
import { contourShaking, radiusForMmi, shakingFor, type Quake, type ShakingModel } from '../geo/shaking.ts'
import { zipsWithin, type ZipPoint } from '../geo/zips.ts'
import { mmiToPgaG } from '../geo/shaking.ts'
import { publishSitrepPdf, writeSitrep, type Setting } from './analyst.ts'
import { localHour, runCasualtyStage } from './casualty.ts'
import { runForecastStage } from './forecast.ts'
import { runLifelineStage, type LifelineZip } from './lifeline.ts'
import { runDroneStage } from './logistics.ts'
import { runSurgeStage, type SurgeCandidate } from './surge.ts'
import type { HospitalProfile } from '../context/hospitals.ts'

type CrewDeps = Pick<Deps, 'chain' | 'facts' | 'sqlite' | 'config' | 'activeRun'> & Partial<Pick<Deps, 'voice' | 'anchors'>>

export interface RunContext {
  q: Quake
  model: ShakingModel
  hospitals: HospitalProfile[]
  zips: ZipPoint[]
  empower: Map<string, EmpowerRow>
  empowerSource: FactSource
  pois: Promise<Poi[]>
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X']
export const roman = (n: number) => ROMAN[Math.max(0, Math.min(10, Math.round(n)))]!

// labels are read aloud and the Verifier checks every number, so a digit in a label is a bug
export const labelSafe = (s: string) => s.replace(/[0-9]+/g, '').replace(/\s{2,}/g, ' ').trim()

const HOSPITAL_RADIUS_KM = 40
const MAX_CONTEXT_KM = 80
const OVERPASS_WAIT_MS = 8_000

export class Orchestrator {
  private deps: CrewDeps

  constructor(deps: CrewDeps) {
    this.deps = deps
  }

  private status(runId: string | null, actor: Actor, text: string, state: 'idle' | 'working' | 'done' | 'blocked' | 'error' = 'working') {
    this.deps.chain.append(actor, 'status', { text, state }, runId)
  }

  private layer(runId: string, name: string, title: string, source: string, features: unknown[]) {
    let kept = features
    let size = JSON.stringify(kept).length
    while (size > MAX_LAYER_BYTES && kept.length > 1) {
      kept = kept.slice(0, Math.floor(kept.length * 0.75))
      size = JSON.stringify(kept).length
    }
    if (kept.length < features.length) {
      this.deps.chain.append('system', 'note', { text: `Map layer ${title} trimmed to fit the log (${kept.length} of ${features.length} shown)` }, runId)
    }
    this.deps.chain.append('orchestrator', 'layer', { name, title, source, geojson: { type: 'FeatureCollection', features: kept } }, runId)
  }

  // Creates the event and run records, writes the opening entries, and kicks the crew off.
  begin(
    event: HazardEvent,
    mode: RunMode,
    opts: {
      asOf?: string | null
      stopAfterContext?: boolean
      // records only: the caller runs its own stages
      noStages?: boolean
      onDone?: (runId: string) => void | Promise<void>
    } = {},
  ): string {
    const { chain, sqlite, activeRun } = this.deps
    const previous = activeRun.current
    if (previous) chain.append('orchestrator', 'run.ended', { status: 'stopped', note: 'replaced by a new run' }, previous)

    const runId = `run-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`
    const now = new Date().toISOString()
    sqlite
      .prepare(
        `INSERT INTO events (id, type, title, geometry, severity, sources, detected_at, ingested_at, tier, status, is_drill)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.type,
        event.title,
        JSON.stringify(event.geometry),
        JSON.stringify(event.severity),
        JSON.stringify(event.sources),
        event.detected_at,
        event.ingested_at,
        event.tier,
        event.status,
        event.is_drill ? 1 : 0,
      )
    sqlite
      .prepare('INSERT INTO runs (id, event_id, mode, as_of, status, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(runId, event.id, mode, opts.asOf ?? null, 'running', now)

    chain.append(event.is_drill ? 'operator' : 'feeds', 'event.detected', { event }, runId)
    chain.append('orchestrator', 'event.tiered', {
      event_id: event.id,
      tier: event.tier,
      reason: event.is_drill ? 'tier forced: drill' : 'set by the feed',
    }, runId)
    chain.append('orchestrator', 'run.started', {
      event_id: event.id,
      mode,
      title: event.title,
      as_of: opts.asOf ?? null,
      detected_at: event.detected_at,
    }, runId)
    chain.append('orchestrator', 'ledger', { milestone: 'detected' }, runId)

    // after the response goes out; the stage does a second of synchronous geometry first
    if (opts.noStages) return runId
    setImmediate(() => {
      this.contextStage(runId, event)
        .then((ctx) => (ctx && opts.stopAfterContext !== true ? this.crewStage(runId, event, ctx) : undefined))
        .then(() => opts.onDone?.(runId))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          chain.append('orchestrator', 'error', { where: 'run', message }, runId)
          this.status(runId, 'orchestrator', `Run stopped: ${message}`, 'error')
        })
    })
    return runId
  }

  // A light run for one place: no hazard, just the next three days.
  beginForecast(label: string, lat: number, lon: number): string {
    const now = new Date().toISOString()
    const id = `forecast-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`
    const event: HazardEvent = {
      id,
      type: 'natural',
      title: `Next three days · ${label}`,
      geometry: { type: 'Point', coordinates: [lon, lat] },
      severity: {},
      sources: [{ name: 'Operator request', id, published_at: now }],
      detected_at: now,
      ingested_at: now,
      tier: 0,
      status: 'watch',
      is_drill: false,
    }
    const runId = this.begin(event, 'any_hospital', { noStages: true })
    const { chain, facts, config } = this.deps
    setImmediate(() => {
      runForecastStage({ chain, facts, scienceUrl: config.SCIENCE_URL }, runId, { lat, lon, label })
        .then((out) => {
          // a newer run may have replaced this one already
          if (this.deps.activeRun.current !== runId) return
          chain.append('orchestrator', 'run.ended', out ? { status: 'done' } : { status: 'failed', note: 'no forecast' }, runId)
        })
        .catch(() => {})
    })
    return runId
  }

  async contextStage(runId: string, event: HazardEvent): Promise<RunContext | null> {
    const { facts, config, sqlite } = this.deps
    const coords = event.geometry.coordinates as number[]
    const sev = event.severity as { mag: number; depth_km: number }
    const q: Quake = { lon: coords[0]!, lat: coords[1]!, mag: sev.mag, depth_km: sev.depth_km }
    const retrieved = new Date().toISOString()
    const computed = (name: string): FactSource => ({ name, retrieved_at: retrieved, method: 'computed' })
    const eventSource: FactSource = event.is_drill
      ? { name: 'Drill scenario set by the operator', retrieved_at: retrieved, method: 'operator' }
      : { name: event.sources[0]?.name ?? 'feed', url: event.sources[0]?.url, retrieved_at: retrieved, method: 'api' }

    this.status(runId, 'orchestrator', `Building the picture for ${event.title}`)
    this.status(runId, 'feeds', event.is_drill ? 'Drill injected by the operator; live feeds keep running' : 'Event taken from the feed', 'done')
    this.status(runId, 'verifier', 'Nothing to check yet; waiting for the first draft', 'idle')
    this.status(runId, 'comms', 'No calls until the sitrep is verified and approved', 'idle')
    this.status(runId, 'logistics', 'Waiting for the damage zone', 'idle')

    // --- shaking ---
    this.status(runId, 'analyst', 'Estimating the shaking footprint')
    const model = shakingFor(q)
    const damageMmi = config.DAMAGE_MMI
    const damageKm = Math.max(5, radiusForMmi(model, q, damageMmi))
    const strongKm = Math.min(MAX_CONTEXT_KM, Math.max(damageKm, radiusForMmi(model, q, 6)))
    const shape = contourShaking(model, q)
    const modelName = model.calibrated
      ? 'Intensity equation for eastern North America, calibrated on the Mineral Virginia quake'
      : model.region === 'ena'
        ? 'Intensity equation for eastern North America'
        : 'Intensity equation, active-crust form (no regional calibration)'

    facts.add(runId, { key: 'event.magnitude', label: 'Magnitude', value: q.mag, unit: 'magnitude', source: eventSource }, 'orchestrator')
    facts.add(runId, { key: 'event.depth_km', label: 'Depth', value: q.depth_km, unit: 'km', display: `${q.depth_km} km`, spoken: `${q.depth_km} kilometres`, source: eventSource }, 'orchestrator')
    facts.add(runId, { key: 'event.shaking_model', label: 'Shaking model', value: modelName, unit: 'text', source: computed('Atkinson, Worden and Wald intensity equation') })
    facts.add(runId, { key: 'event.max_mmi', label: 'Strongest shaking in the model', value: Number(shape.max_mmi.toFixed(1)), unit: 'mmi', display: `${roman(shape.max_mmi)} (${shape.max_mmi.toFixed(1)})`, spoken: `intensity ${roman(shape.max_mmi)}`, tolerance: { abs: 0.1 }, source: computed(modelName) })
    facts.add(runId, { key: 'event.damage_radius_km', label: `Radius of damaging shaking, level ${roman(damageMmi)} and above`, value: Math.round(damageKm), unit: 'km', display: `${Math.round(damageKm)} km`, spoken: `${Math.round(damageKm)} kilometres`, tolerance: { abs: 1 }, source: computed(modelName) })
    this.layer(runId, 'shaking', 'Shaking intensity', modelName, shape.features)
    this.status(runId, 'analyst', `Shaking reaches level ${roman(shape.max_mmi)}; damaging shaking out to about ${Math.round(damageKm)} km`, 'done')

    // --- slow outside calls, one at a time for Overpass, alongside the local work ---
    const zipPoints = zipsWithin(model, q, strongKm)
    const poisPromise = (async () => {
      this.status(runId, 'scout', 'Asking OpenStreetMap for schools, shelters, fire, police and substations')
      const r = await fetchPois({ lon: q.lon, lat: q.lat, zoneKm: damageKm, hospitalsKm: HOSPITAL_RADIUS_KM, substationsKm: strongKm })
      this.deps.chain.append('scout', 'fetch', { source: 'overpass', url: r.url, method: 'POST', status: r.res.status, bytes: r.res.body.length, ms: r.res.ms, from_tape: r.res.fromTape }, runId)
      return r.pois
    })()
    // handled below; this keeps an early failure from counting as unhandled while we work
    poisPromise.catch(() => {})
    const empowerPromise = (async () => {
      const started = Date.now()
      const r = await fetchEmpower(zipPoints.map((z) => z.zcta))
      this.deps.chain.append('scout', 'fetch', {
        source: 'empower',
        url: EMPOWER_LAYER,
        status: r.source === 'seed' ? 0 : 200,
        ms: Date.now() - started,
        from_tape: r.source !== 'live',
        snippet: r.source === 'seed' ? 'HHS service unreachable; served from the committed snapshot' : `${r.rows.size} ZIP rows`,
      }, runId)
      if (r.source === 'seed') {
        this.deps.chain.append('system', 'fallback.used', { source: 'empower', url: EMPOWER_LAYER, reason: 'service unreachable, using the committed snapshot' }, runId)
      }
      return r
    })()

    // --- population ---
    this.status(runId, 'analyst', 'Counting people in each shaking band from Census block groups')
    const exp = exposureByBand(model, q)
    const popSource = computed(`${exp.source} × ${modelName}`)
    for (const b of BANDS) {
      facts.add(runId, { key: `exposure.pop_mmi.${b}`, label: `People exposed to shaking level ${roman(b)}`, value: Math.round(exp.bands[b]), unit: 'people', tolerance: { rel: 0.02 }, source: popSource })
    }
    const inDamage = Object.entries(exp.bands).filter(([b]) => Number(b) >= Math.round(damageMmi)).reduce((t, [, v]) => t + v, 0)
    facts.add(runId, { key: 'exposure.pop_damaging', label: `People in damaging shaking, level ${roman(damageMmi)} and above`, value: Math.round(inDamage), unit: 'people', tolerance: { rel: 0.02 }, source: popSource })
    this.status(runId, 'analyst', `About ${(inDamage / 1e6).toFixed(1)} million people in damaging shaking; casualty estimate next`, 'done')
    this.deps.chain.append('analyst', 'model.output', { model: 'exposure', version: 'census-2020-bg', outputs: { bands: exp.bands, searched_km: Math.round(exp.searched_km), points: exp.points, calibrated: model.calibrated } }, runId)

    // --- hospitals ---
    this.status(runId, 'scout', `Loading hospital profiles within ${HOSPITAL_RADIUS_KM} km from the FEMA hospital list`)
    const seed = raptSeed()
    const hospitals = hospitalsNear(q.lon, q.lat, HOSPITAL_RADIUS_KM)
    saveProfiles(sqlite, hospitals, seed.retrieved_at)
    const raptSource: FactSource = { name: RAPT_SOURCE, url: RAPT_URL, retrieved_at: seed.retrieved_at, method: 'dataset' }
    const hospitalFeatures = []
    for (const h of hospitals) {
      const name = labelSafe(h.name)
      const at = model.at(h.lon, h.lat)
      if (h.beds != null) facts.add(runId, { key: `hospital.${h.id}.beds`, label: `Beds, ${name}`, value: h.beds, unit: 'beds', source: raptSource }, 'scout')
      facts.add(runId, { key: `hospital.${h.id}.trauma`, label: `Trauma designation, ${name}`, value: traumaLabel(h.trauma), unit: 'text', source: raptSource }, 'scout')
      if (h.phone) facts.add(runId, { key: `hospital.${h.id}.phone`, label: `Main phone, ${name}`, value: h.phone, unit: 'text', source: raptSource }, 'scout')
      facts.add(runId, { key: `hospital.${h.id}.mmi`, label: `Shaking at ${name}`, value: Number(at.mmi.toFixed(1)), unit: 'mmi', display: `${roman(at.mmi)} (${at.mmi.toFixed(1)})`, spoken: `intensity ${roman(at.mmi)}`, tolerance: { abs: 0.1 }, source: computed(modelName) })
      hospitalFeatures.push({
        type: 'Feature',
        properties: { id: h.id, name: h.name, beds: h.beds, trauma: traumaLabel(h.trauma), mmi: Number(at.mmi.toFixed(2)), dist_km: Number((h.dist_km ?? 0).toFixed(1)) },
        geometry: { type: 'Point', coordinates: [h.lon, h.lat] },
      })
    }
    this.layer(runId, 'hospitals', 'Hospitals', RAPT_SOURCE, hospitalFeatures)
    this.status(runId, 'scout', `${hospitals.length} hospitals profiled from the FEMA list`, 'done')
    this.status(runId, 'scout', CMS_FACILITIES_STATUS, 'blocked')

    // --- ZIPs and emPOWER ---
    let empower: Map<string, EmpowerRow> = new Map()
    let empowerSource: FactSource = { name: 'HHS emPOWER', url: EMPOWER_LAYER, retrieved_at: retrieved, method: 'api' }
    try {
      const r = await empowerPromise
      empower = r.rows
      if (r.source === 'seed') empowerSource = { ...empowerSource, name: 'HHS emPOWER (committed snapshot)', method: 'dataset' }
    } catch (err) {
      this.status(runId, 'scout', `emPOWER lookup failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
    }
    const zipFeatures = []
    let damagingDependent = 0
    let damagingMasked = 0
    let damagingZips = 0
    for (const z of zipPoints) {
      const row = empower.get(z.zcta)
      const dependent = row?.power_dependent ?? null
      zipFeatures.push({
        type: 'Feature',
        properties: {
          zcta: z.zcta,
          mmi: Number(z.mmi.toFixed(2)),
          power_dependent: dependent,
          masked: isMasked(dependent),
          oxygen: row?.devices.O2_Concentrators_36mo ?? null,
          county: row?.county ?? null,
        },
        geometry: { type: 'Point', coordinates: [z.lon, z.lat] },
      })
      if (z.mmi < damageMmi || !row || dependent == null) continue
      damagingZips++
      damagingDependent += dependent
      if (isMasked(dependent)) damagingMasked++
      const where = row.county ? `, ${labelSafe(row.county)}` : ''
      facts.add(runId, {
        key: `zip.${z.zcta}.power_dependent`,
        label: `Power-dependent Medicare residents in this ZIP${where}`,
        value: dependent,
        unit: 'people',
        display: isMasked(dependent) ? '≤11' : undefined,
        spoken: isMasked(dependent) ? 'eleven or fewer' : undefined,
        source: empowerSource,
      }, 'scout')
      const o2 = row.devices.O2_Concentrators_36mo
      if (o2 != null) {
        facts.add(runId, {
          key: `zip.${z.zcta}.oxygen`,
          label: `Home oxygen concentrator users in this ZIP${where}`,
          value: o2,
          unit: 'people',
          display: isMasked(o2) ? '≤11' : undefined,
          spoken: isMasked(o2) ? 'eleven or fewer' : undefined,
          source: empowerSource,
        }, 'scout')
      }
      facts.add(runId, { key: `zip.${z.zcta}.mmi`, label: `Shaking in this ZIP${where}`, value: Number(z.mmi.toFixed(1)), unit: 'mmi', display: `${roman(z.mmi)} (${z.mmi.toFixed(1)})`, spoken: `intensity ${roman(z.mmi)}`, tolerance: { abs: 0.1 }, source: computed(modelName) })
    }
    if (damagingZips) {
      facts.add(runId, {
        key: 'context.power_dependent.damaging',
        label: `Power-dependent Medicare residents in ZIPs with shaking ${roman(damageMmi)} and above`,
        value: damagingDependent,
        unit: 'people',
        display: damagingMasked ? `up to ${damagingDependent.toLocaleString('en-US')}` : undefined,
        spoken: damagingMasked ? `up to ${damagingDependent.toLocaleString('en-US')}` : undefined,
        source: empowerSource,
      }, 'scout')
    }
    this.layer(runId, 'zips', 'Power-dependent residents by ZIP', 'HHS emPOWER × Census ZCTA points', zipFeatures)

    // --- OpenStreetMap places ---
    // A slow Overpass answer mustn't hold up the ledger: after the wait, context is marked built and
    // the places land when they arrive.
    const late = Symbol('late')
    const first = await Promise.race([
      poisPromise.catch((err: unknown) => err as Error),
      new Promise<typeof late>((r) => setTimeout(() => r(late), OVERPASS_WAIT_MS)),
    ])
    const ctx: RunContext = {
      q,
      model,
      hospitals,
      zips: zipPoints,
      empower,
      empowerSource,
      pois: poisPromise.catch(() => [] as Poi[]),
    }
    if (first === late) {
      this.status(runId, 'scout', 'OpenStreetMap is slow; schools and substations will follow')
      this.contextBuilt(runId)
      poisPromise.then(
        (pois) => this.addPlaces(runId, model, damageMmi, pois, retrieved),
        (err: unknown) => this.status(runId, 'scout', err instanceof Error ? err.message : String(err), 'error'),
      )
      return ctx
    }
    if (first instanceof Error) this.status(runId, 'scout', first.message, 'error')
    else this.addPlaces(runId, model, damageMmi, first, retrieved)
    this.contextBuilt(runId)
    return ctx
  }

  // Casualties, surge, lifeline, the drone plan, the sitrep, then the calls.
  async crewStage(runId: string, event: HazardEvent, ctx: RunContext) {
    const { chain, facts, config, voice, anchors } = this.deps
    const { q, model } = ctx
    const sev = event.severity as { origin_time?: string }
    const pops = Object.fromEntries(BANDS.map((b) => [b, facts.byKey(runId, `exposure.pop_mmi.${b}`)?.value as number ?? 0]))

    const casualty = await runCasualtyStage(
      { chain, facts },
      runId,
      {
        popMmi: pops,
        magnitude: q.mag,
        depthKm: q.depth_km,
        localHour: localHour(sev.origin_time ?? event.detected_at, event.tz, q.lon),
        // our exposure comes from US Census block groups, so this path is US-only for now
        iso3: 'USA',
      },
      config.SCIENCE_URL,
      config.CASUALTY_PLANNING,
    )

    const candidates: SurgeCandidate[] = ctx.hospitals.map((h) => ({
      id: h.id,
      name: h.name,
      lat: h.lat,
      lon: h.lon,
      zip: h.zip,
      state: h.state,
      beds: h.beds,
      pgaG: mmiToPgaG(model.at(h.lon, h.lat).mmi),
    }))
    const surge = casualty ? await runSurgeStage({ chain, facts }, runId, candidates, { lon: q.lon, lat: q.lat }) : []
    if (!casualty) this.status(runId, 'analyst', 'Surge forecast skipped: no casualty estimate', 'blocked')

    const lifeline = (async () => {
      const pois = await Promise.race([ctx.pois, new Promise<Poi[]>((r) => setTimeout(() => r([]), 20_000))])
      const substations = pois
        .filter((p) => p.kind === 'substation')
        .map((p) => ({
          id: p.osm,
          lon: p.lon,
          lat: p.lat,
          pgaG: mmiToPgaG(model.at(p.lon, p.lat).mmi),
          voltage: voltageClass(p.tags.voltage) ?? 'medium',
        }))
      if (!substations.length) this.status(runId, 'analyst', 'No substations from OpenStreetMap yet; outage estimate uses street circuits only', 'working')
      const zips: LifelineZip[] = ctx.zips
        .filter((z) => z.mmi >= config.DAMAGE_MMI - 1)
        .map((z) => {
          const row = ctx.empower.get(z.zcta)
          return {
            zcta: z.zcta,
            lon: z.lon,
            lat: z.lat,
            pgaG: z.pga_g,
            powerDependent: row?.power_dependent ?? null,
            oxygen: row?.devices.O2_Concentrators_36mo ?? null,
            ventilators: row?.devices.Ventilators_13mo ?? null,
            masked: isMasked(row?.power_dependent),
          }
        })
      return runLifelineStage({ chain, facts }, runId, zips, substations, ctx.empowerSource)
    })()
    // the three-day outlook doesn't hold up the sitrep; its facts land when HRRR answers
    void runForecastStage({ chain, facts, scienceUrl: config.SCIENCE_URL }, runId, { lat: q.lat, lon: q.lon, label: 'the event area' }).catch(() => {})
    const drone = runDroneStage({ chain, facts }, runId, { lon: q.lon, lat: q.lat }, config.artifactsDir)
    const [zipRows] = await Promise.all([lifeline, drone])

    const mode = this.deps.sqlite.prepare<[string], { mode: string }>('SELECT mode FROM runs WHERE id = ?').get(runId)?.mode
    const setting: Setting = event.is_drill ? 'drill' : mode === 'rerun' || mode === 'replay' || mode === 'time_machine' ? 'rerun' : 'live'
    const sitrep = await writeSitrep({ chain, facts, runId, setting, injectFault: config.DEMO_INJECT_FAULT || undefined })
    await publishSitrepPdf({ chain, facts, runId, setting }, sitrep, event.title, config.artifactsDir)

    if (event.tier !== 2) {
      this.status(runId, 'orchestrator', 'Below tier two: no calls, watching only', 'done')
      return
    }
    if (!voice) return
    const first = surge.find((r) => r.minutes.p50 !== null) ?? surge[0]
    const nurseKeys = [
      'event.magnitude',
      'casualty.injured.planning',
      first ? `surge.${first.id}.share` : '',
      first ? `surge.${first.id}.arrivals_3h` : '',
      first ? `surge.${first.id}.minutes_to_full` : '',
      first ? `surge.${first.id}.divert_to` : '',
    ].filter(Boolean)
    voice.queue.enqueue({
      role: 'charge_nurse',
      runId,
      partyLabel: first ? `${labelSafe(first.name)} ED charge desk (drill stand-in)` : 'ED charge desk (drill stand-in)',
      hospitalLabel: first ? labelSafe(first.name) : undefined,
      reason: first ? `${labelSafe(first.name)} is expected to fill first` : 'Mass-casualty pre-notification',
      headlineKeys: nurseKeys,
    })
    const topZip = zipRows[0]
    if (topZip) {
      const zipKeys = [`zip.${topZip.zcta}.code`, `zip.${topZip.zcta}.power_dependent`, `zip.${topZip.zcta}.outage_probability`, `zip.${topZip.zcta}.restoration`]
      voice.queue.enqueue({ role: 'lifeline_county', runId, partyLabel: 'County health (drill stand-in)', reason: 'Power-dependent residents at risk of outage', headlineKeys: zipKeys, zip: topZip.zcta })
      voice.queue.enqueue({ role: 'lifeline_dme', runId, partyLabel: 'Home equipment supplier (drill stand-in)', reason: 'Oxygen and ventilator users at risk of outage', headlineKeys: zipKeys, zip: topZip.zcta })
    }
    this.status(runId, 'comms', voice.telephony ? 'Calls queued; each waits for approval' : 'Calls queued, but Twilio is not configured', 'working')
    this.status(runId, 'orchestrator', 'Crew finished; calls are with the operator', 'done')
    void anchors?.submit(runId)
  }

  private contextBuilt(runId: string) {
    this.deps.chain.append('orchestrator', 'ledger', { milestone: 'context_built' }, runId)
    this.status(runId, 'orchestrator', 'Context is ready; the casualty estimate comes next', 'idle')
  }

  private addPlaces(runId: string, model: ShakingModel, damageMmi: number, pois: Poi[], retrieved: string) {
    const { facts } = this.deps
    if (pois.length) {
      const osm: FactSource = { name: 'OpenStreetMap via Overpass', url: 'https://www.openstreetmap.org', retrieved_at: retrieved, method: 'api' }
      const inZone = (p: Poi) => model.at(p.lon, p.lat).mmi >= damageMmi
      const count = (kind: Poi['kind']) => pois.filter((p) => p.kind === kind && inZone(p)).length
      const zoneWord = `in shaking ${roman(damageMmi)} and above`
      facts.add(runId, { key: 'context.schools.damaging', label: `Schools ${zoneWord}`, value: count('school'), unit: 'count', source: osm }, 'scout')
      facts.add(runId, { key: 'context.shelters.damaging', label: `Mapped emergency and public shelters ${zoneWord}`, value: count('shelter'), unit: 'count', source: osm }, 'scout')
      facts.add(runId, { key: 'context.fire_stations.damaging', label: `Fire stations ${zoneWord}`, value: count('fire_station'), unit: 'count', source: osm }, 'scout')
      facts.add(runId, { key: 'context.police.damaging', label: `Police stations ${zoneWord}`, value: count('police'), unit: 'count', source: osm }, 'scout')
      const care = careHomesFromOsm(pois.filter(inZone))
      facts.add(runId, { key: 'context.care_homes.damaging', label: `Care homes ${zoneWord}, from OpenStreetMap, not the CMS list`, value: care.length, unit: 'count', source: osm }, 'scout')
      const subs = pois.filter((p) => p.kind === 'substation')
      const high = subs.filter((p) => voltageClass(p.tags.voltage) === 'high').length
      facts.add(runId, { key: 'context.substations', label: 'Electric substations mapped in the strong-shaking area', value: subs.length, unit: 'count', source: osm }, 'scout')
      facts.add(runId, { key: 'context.substations.high_voltage', label: 'High-voltage substations mapped in the strong-shaking area', value: high, unit: 'count', source: osm }, 'scout')

      const places = pois
        .filter((p) => p.kind !== 'substation' && p.kind !== 'hospital' && p.kind !== 'clinic' && inZone(p))
        .sort((a, b) => model.at(a.lon, a.lat).repi_km - model.at(b.lon, b.lat).repi_km)
        .map((p) => ({ type: 'Feature', properties: { osm: p.osm, kind: p.kind, name: p.name }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } }))
      this.layer(runId, 'places', 'Schools, shelters, fire, police and care homes', 'OpenStreetMap', places)
      this.layer(runId, 'substations', 'Electric substations', 'OpenStreetMap', subs.map((p) => ({
        type: 'Feature',
        properties: { osm: p.osm, name: p.name, voltage: p.tags.voltage ?? null, class: voltageClass(p.tags.voltage) },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      })))
      this.status(runId, 'scout', `OpenStreetMap: ${places.length} places in the damage zone, ${subs.length} substations nearby`, 'done')
    }
  }
}
