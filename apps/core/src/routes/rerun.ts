import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { Orchestrator } from '../crew/orchestrator.ts'
import { SCENARIOS, hindsightFor, loadScenario, recordGrade, rerunEvent, rerunFromPager, type Scenario } from '../modes/rerun.ts'
import type { CasualtyOut } from '../crew/casualty.ts'
import type { Deps } from '../server.ts'

const Body = z.object({ scenario: z.enum(Object.keys(SCENARIOS) as [Scenario, ...Scenario[]]) })

export function registerRerun(app: FastifyInstance, deps: Deps) {
  const crew = new Orchestrator(deps)

  app.get('/api/rerun/scenarios', async () =>
    Object.entries(SCENARIOS).map(([name, s]) => {
      const { pager, truth } = loadScenario(name as Scenario)
      return {
        name,
        label: s.label,
        title: pager.title,
        first_estimate_minutes: s.ownPipeline ? null : pager.minutes_after_origin,
        recorded_deaths: truth.deaths.value,
      }
    }),
  )

  app.post('/api/rerun', { preHandler: deps.requireOperator }, async (req, reply) => {
    const body = Body.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: `Pick a scenario: ${Object.keys(SCENARIOS).join(', ')}.` })
    const name = body.data.scenario
    const { pager, final, truth } = loadScenario(name)
    const own = SCENARIOS[name].ownPipeline
    const event = rerunEvent(own ? final : pager, own)

    if (!own) {
      const runId = crew.begin(event, 'rerun', { noStages: true })
      setImmediate(() => {
        rerunFromPager(deps, runId, name).catch((err: Error) =>
          deps.chain.append('orchestrator', 'error', { where: 'rerun', message: err.message }, runId),
        )
      })
      return reply.code(202).send({ run_id: runId, title: event.title })
    }

    // a US quake runs through the whole crew, then gets graded
    const runId = crew.begin(event, 'rerun', {
      onDone: async (id) => {
        const casualty = deps.chain
          .after(0, 100_000)
          .findLast((e) => e.run_id === id && e.kind === 'model.output' && e.payload.model === 'casualty')
        if (!casualty || casualty.kind !== 'model.output') return
        const hindsight = await hindsightFor(final, deps.config.SCIENCE_URL)
        recordGrade(deps, id, truth, casualty.payload.outputs as unknown as CasualtyOut, deps.config.CASUALTY_PLANNING, hindsight)
        deps.chain.append('orchestrator', 'run.ended', { status: 'done', note: 'rerun graded' }, id)
      },
    })
    return reply.code(202).send({ run_id: runId, title: event.title })
  })
}
