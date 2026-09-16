import { useEffect, useState } from 'react'
import type { HazardEvent } from '@sentinel/shared'
import { activeRun } from '../store/fold'
import { useConsole } from '../store/stream'

export function useNow(everyMs = 1000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}

export function useActiveRun() {
  return useConsole((s) => activeRun(s.view))
}

export function useActiveEvent(): HazardEvent | null {
  return useConsole((s) => {
    const run = activeRun(s.view)
    return run ? (s.view.events[run.event_id] ?? null) : null
  })
}

export type ModeKind = 'drill' | 'live' | 'past' | 'unknown'

export function useMode(): { kind: ModeKind; label: string; detail: string | null } {
  const run = useActiveRun()
  const drillSwitch = useConsole((s) => s.view.switches.drill)
  const server = useConsole((s) => s.server)

  if (run) {
    if (run.mode === 'time_machine') return { kind: 'past', label: 'Time machine', detail: run.as_of }
    if (run.mode === 'replay') return { kind: 'past', label: 'Replay', detail: run.title }
    if (run.mode === 'rerun') return { kind: 'past', label: 'Rerun', detail: run.as_of }
    if (run.mode === 'drill') return { kind: 'drill', label: 'Drill', detail: null }
  }
  const drillOn = drillSwitch ?? server?.drill_on ?? null
  if (drillOn === null) return { kind: 'unknown', label: 'Connecting', detail: null }
  return drillOn ? { kind: 'drill', label: 'Drill', detail: null } : { kind: 'live', label: 'Live', detail: null }
}
