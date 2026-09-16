import { useMemo } from 'react'
import type { Fact } from '@sentinel/shared'
import { currentFacts } from '../../store/fold'
import { useConsole } from '../../store/stream'
import { EmptyState, FactHover, Panel } from '../ui'
import { CasualtyCard, useCasualties } from './Casualties'
import { LifelineList } from './Lifeline'
import { NextDays } from './NextDays'
import { SurgeTable, useSurge } from './Surge'

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
  const casualties = useCasualties()
  const surge = useSurge()
  return (
    <Panel
      title="Now"
      aside={<HorizonTitle index="01" name="Acute" span="minutes to hours" />}
      className="flex-[1.9]"
      bodyClass="flex flex-col"
      delay={100}
    >
      {casualties || surge.length ? (
        <>
          <div className="shrink-0 border-b border-line">
            <CasualtyCard />
          </div>
          <SurgeTable />
        </>
      ) : (
        <div className="grid h-full grid-cols-2 divide-x divide-line">
          <EmptyState title="Casualty estimate">
            Expected deaths and injuries with an error band and the features that drove them. Appears when the ledger reaches Casualties.
          </EmptyState>
          <EmptyState title="Hospital surge">
            Which hospital fills first, arrivals at 3 and 6 hours against real bed counts, and where to divert. Appears when the ledger reaches Surge.
          </EmptyState>
        </div>
      )}
    </Panel>
  )
}

export function NextPanel() {
  return (
    <Panel title="Next 72 h" aside={<HorizonTitle index="02" name="Forecast" span="three days" />} className="min-w-0 flex-1" bodyClass="overflow-y-auto" delay={160}>
      <NextDays />
    </Panel>
  )
}

export function CommunityPanel() {
  return (
    <Panel title="Community" aside={<HorizonTitle index="03" name="Lifeline" span="power-dependent" />} className="flex-1" delay={200}>
      <LifelineList />
    </Panel>
  )
}
