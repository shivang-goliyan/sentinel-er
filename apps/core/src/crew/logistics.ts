import { join } from 'node:path'
import type { FactStore } from '../facts/store.ts'
import type { LogChain } from '../log/chain.ts'
import { DEFAULT_SURVEY, planSurvey, toQgcPlan, writePlan } from '../logistics/drone-plan.ts'

const SURVEY_HALF_SIDE_KM = 1.5

export async function runDroneStage(
  d: { chain: LogChain; facts: FactStore },
  runId: string,
  epicentre: { lon: number; lat: number },
  artifactsDir: string,
) {
  const { chain, facts } = d
  chain.append('logistics', 'status', { text: 'Planning the survey flight over the worst-hit area' }, runId)
  const survey = planSurvey([epicentre.lat, epicentre.lon], SURVEY_HALF_SIDE_KM)
  const first = survey.sorties[0] ?? []
  try {
    const bytes = await writePlan(join(artifactsDir, runId), toQgcPlan(survey.home, first))
    const now = new Date().toISOString()
    const source = {
      name: `Sentinel survey planner (camera ${DEFAULT_SURVEY.hfovDeg}° at ${DEFAULT_SURVEY.altitudeM} m, ${Math.round(DEFAULT_SURVEY.sideOverlap * 100)}% overlap, ${DEFAULT_SURVEY.enduranceMin} min battery; assumptions)`,
      retrieved_at: now,
      method: 'computed' as const,
    }
    facts.add(runId, { key: 'drone.sorties', label: 'Survey flights needed to cover the worst-hit square', value: survey.sorties.length, unit: 'count', source }, 'logistics')
    facts.add(runId, { key: 'drone.area', label: 'Area covered by the survey', value: Math.round(survey.areaKm2 * 10) / 10, unit: 'count', display: `${survey.areaKm2.toFixed(1)} km²`, source }, 'logistics')
    chain.append('logistics', 'layer', {
      name: 'drone-survey',
      title: 'Drone survey, first flight',
      source: 'Sentinel survey planner',
      geojson: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { kind: 'survey', sortie: 1 },
            geometry: { type: 'LineString', coordinates: [survey.home, ...first, survey.home].map(([lat, lon]) => [lon, lat]) },
          },
        ],
      },
    }, runId)
    chain.append('logistics', 'artifact', { type: 'drone_plan', name: 'drone.plan', url: `/api/runs/${runId}/drone.plan`, bytes }, runId)
    chain.append('logistics', 'status', { text: `Survey plan ready: first of ${survey.sorties.length} flights, opens in QGroundControl`, state: 'done' }, runId)
  } catch (err) {
    chain.append('logistics', 'error', { where: 'drone plan', message: (err as Error).message }, runId)
  }
  return survey
}
