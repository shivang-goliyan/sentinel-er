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
import { zipsWithin } from '../geo/zips.ts'

type CrewDeps = Pick<Deps, 'chain' | 'facts' | 'sqlite' | 'config' | 'activeRun'>

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
  begin(event: HazardEvent, mode: RunMode, opts: { asOf?: string | null } = {}): string {
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
    setImmediate(() => {
      this.contextStage(runId, event).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        chain.append('orchestrator', 'error', { where: 'context stage', message }, runId)
        this.status(runId, 'orchestrator', `Context stage failed: ${message}`, 'error')
      })
    })
    return runId
  }

  async contextStage(runId: string, event: HazardEvent) {
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
    if (first === late) {
      this.status(runId, 'scout', 'OpenStreetMap is slow; schools and substations will follow')
      this.contextBuilt(runId)
      poisPromise.then(
        (pois) => this.addPlaces(runId, model, damageMmi, pois, retrieved),
        (err: unknown) => this.status(runId, 'scout', err instanceof Error ? err.message : String(err), 'error'),
      )
      return
    }
    if (first instanceof Error) this.status(runId, 'scout', first.message, 'error')
    else this.addPlaces(runId, model, damageMmi, first, retrieved)
    this.contextBuilt(runId)
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
