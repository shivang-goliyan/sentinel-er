import { useMemo } from 'react'
import type { Fact } from '@sentinel/shared'
import { currentFacts } from '../../store/fold'
import { useConsole } from '../../store/stream'
import { EmptyState, FactHover, Panel } from '../ui'

function useRunFacts(prefixes: string[]): Fact[] {
  const facts = useConsole((s) => s.view.facts)
  const factOrder = useConsole((s) => s.view.factOrder)
  const superseded = useConsole((s) => s.view.superseded)
  const runId = useConsole((s) => s.view.activeRunId)
  const key = prefixes.join('|')
  return useMemo(
    () =>
      currentFacts({ facts, factOrder, superseded }, runId).filter((f) =>
        key.split('|').some((p) => f.key.startsWith(p)),
      ),
    [facts, factOrder, superseded, runId, key],
  )
}

function HorizonTitle({ index, name, span }: { index: string; name: string; span: string }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="num text-faint">{index}</span>
      <span className="text-paper">{name}</span>
      <span className="normal-case tracking-normal text-faint">{span}</span>
    </span>
  )
}

function FactGrid({ facts }: { facts: Fact[] }) {
  return (
    <ul className="grid grid-cols-2 gap-px bg-line p-px xl:grid-cols-3">
      {facts.map((f) => (
        <li key={f.id} className="bg-ink-900">
          <FactHover fact={f} className="block cursor-help px-3 py-2.5 hover:bg-ink-850">
            <span className="block truncate text-[12px] text-muted">{f.label}</span>
            <span className="num mt-0.5 block text-[22px] leading-tight text-paper">{f.display}</span>
            <span className="mt-0.5 block truncate text-[11px] text-faint">
              <span className="num">{f.id}</span> · {f.source.name}
            </span>
          </FactHover>
        </li>
      ))}
    </ul>
  )
}

export function NowPanel() {
  const facts = useRunFacts(['casualty.', 'surge.', 'exposure.'])
  return (
    <Panel
      title="Now"
      aside={<HorizonTitle index="01" name="Acute" span="minutes to hours" />}
      className="flex-[1.35]"
      bodyClass="overflow-y-auto"
      delay={100}
    >
      {facts.length ? (
        <FactGrid facts={facts} />
      ) : (
        <div className="grid h-full grid-cols-2 divide-x divide-line">
          <EmptyState title="Casualty estimate">
            Expected deaths and injuries with an error band and the features that drove them. Appears when the ledger reaches Casualties.
          </EmptyState>
          <EmptyState title="Hospital surge">
            Which hospital fills first, arrivals at 1, 3 and 6 hours against real bed counts, and where to divert. Appears when the ledger reaches Surge.
          </EmptyState>
        </div>
      )}
    </Panel>
  )
}

export function NextPanel() {
  const facts = useRunFacts(['ed_demand.', 'smoke.', 'heat.'])
  return (
    <Panel title="Next 72 h" aside={<HorizonTitle index="02" name="Forecast" span="three days" />} className="flex-1" bodyClass="overflow-y-auto" delay={160}>
      {facts.length ? (
        <FactGrid facts={facts} />
      ) : (
        <EmptyState title="ED demand forecast">
          Expected change in emergency visits from wildfire smoke, heat and storms for each of the next three days, with the source of every hour and staffing suggestions.
        </EmptyState>
      )}
    </Panel>
  )
}

export function CommunityPanel() {
  const facts = useRunFacts(['lifeline.'])
  return (
    <Panel title="Community" aside={<HorizonTitle index="03" name="Lifeline" span="power-dependent" />} className="flex-1" bodyClass="overflow-y-auto" delay={200}>
      {facts.length ? (
        <FactGrid facts={facts} />
      ) : (
        <EmptyState title="Lifeline by ZIP">
          Medicare patients on powered equipment at home, from HHS emPOWER aggregate counts, set against the chance their power fails. We call the county, suppliers and shelters — never patients.
        </EmptyState>
      )}
    </Panel>
  )
}
