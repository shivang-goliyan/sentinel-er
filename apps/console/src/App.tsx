import { useEffect } from 'react'
import { startConsole } from './store/stream'
import { TopBar } from './components/TopBar'
import { LedgerStrip } from './components/LedgerStrip'
import { CrewPanel } from './components/CrewPanel'
import { ActionFeed } from './components/ActionFeed'
import { CommunityPanel, NextPanel, NowPanel } from './components/panels/Horizons'
import { FactsTable } from './components/panels/FactsTable'
import { MapPanel } from './components/MapPanel'
import { CallLog, CallPanel } from './components/CallPanel'
import { Dock, DrawerHost } from './components/Drawers'
import { OperatorDialog } from './components/OperatorDialog'

export function App() {
  useEffect(() => startConsole(), [])

  return (
    <div className="flex h-full min-h-[760px] min-w-[1280px] flex-col overflow-hidden">
      <TopBar />
      <LedgerStrip />
      <main className="grid min-h-0 flex-1 grid-cols-[330px_minmax(0,1fr)_410px] gap-2 p-2">
        <div className="flex min-h-0 flex-col gap-2">
          <CrewPanel />
          <ActionFeed />
        </div>
        <div className="flex min-h-0 flex-col gap-2">
          <NowPanel />
          <div className="flex min-h-0 flex-1 gap-2">
            <NextPanel />
            <CommunityPanel />
          </div>
          <FactsTable />
          <Dock />
        </div>
        <div className="flex min-h-0 flex-col gap-2">
          <MapPanel />
          <CallPanel />
          <CallLog />
        </div>
      </main>
      <DrawerHost />
      <OperatorDialog />
    </div>
  )
}
