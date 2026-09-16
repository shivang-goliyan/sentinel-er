import { memo, useMemo } from 'react'
import type { LogEntry } from '@sentinel/shared'
import { feedLine, utcTime, type Tone } from '../lib/format'
import { useConsole } from '../store/stream'
import { EmptyState, Panel, Tag } from './ui'

const textTone: Record<Tone, string> = {
  plain: 'text-paper-dim',
  good: 'text-paper',
  warn: 'text-warn',
  bad: 'text-bad',
  info: 'text-paper',
  quiet: 'text-muted',
}

const FeedRow = memo(function FeedRow({ entry, fresh }: { entry: LogEntry; fresh: boolean }) {
  const line = feedLine(entry)
  return (
    <li className={`grid grid-cols-[58px_minmax(0,1fr)] gap-2 border-b border-line/50 px-3 py-[7px] ${fresh ? 'animate-arrive' : ''}`}>
      <span className="num pt-px text-[11px] text-faint">{utcTime(entry.ts)}</span>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <Tag tone={line.tone}>{line.tag}</Tag>
          <span className="num text-[10px] text-faint">#{entry.seq}</span>
        </div>
        <p className={`mt-1 break-words text-[13px] leading-snug ${textTone[line.tone]}`}>{line.text}</p>
      </div>
    </li>
  )
})

export function ActionFeed() {
  const feed = useConsole((s) => s.view.feed)
  const rows = useMemo(() => feed.slice().reverse(), [feed])
  const newest = feed.at(-1)?.seq
  return (
    <Panel
      title="Action feed"
      aside={feed.length ? <span className="num">{feed.length} shown</span> : null}
      className="flex-1"
      bodyClass="overflow-y-auto"
      delay={120}
    >
      {rows.length === 0 ? (
        <EmptyState title="Nothing logged yet">
          Every step the crew takes lands here as it happens, newest first. Each line is an entry in the hash-chained log.
        </EmptyState>
      ) : (
        <ol>
          {rows.map((e) => (
            <FeedRow key={e.seq} entry={e} fresh={e.seq === newest} />
          ))}
        </ol>
      )}
    </Panel>
  )
}
