import { useEffect, useMemo, useRef, useState } from 'react'
import { duration, roleLabel, utcTime } from '../lib/format'
import { useNow } from '../lib/hooks'
import { endedCalls, pendingApprovals, type CallView, type TranscriptLine } from '../store/fold'
import { operatorPasscode, operatorPost, useConsole } from '../store/stream'
import { Btn, EmptyState, FactChip, Panel, Tag } from './ui'
import { PhoneBar } from './VoiceControls'

const verdictTag = {
  pass: <Tag tone="good">verified</Tag>,
  pass_with_note: <Tag tone="warn">matched</Tag>,
  block: <Tag tone="bad">blocked</Tag>,
}

function Line({ line, runId }: { line: TranscriptLine; runId: string | null }) {
  if (line.who === 'tool' || line.who === 'system') {
    return (
      <li className="px-3 py-1 font-mono text-[11.5px] text-faint">
        <span className="num mr-2">{utcTime(line.ts)}</span>
        {line.text}
      </li>
    )
  }
  const caller = line.who === 'caller'
  return (
    <li className={`px-3 py-1.5 ${caller ? '' : 'bg-ink-850/60'}`}>
      <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-[0.12em]">
        <span className={caller ? 'text-muted' : 'text-paper-dim'}>{caller ? 'Caller' : 'Sentinel'}</span>
        <span className="num text-faint">{utcTime(line.ts)}</span>
        {line.verdict ? verdictTag[line.verdict] : null}
      </div>
      <p
        className={`mt-0.5 text-[14px] leading-snug ${caller ? 'text-paper-dim' : 'text-paper'} ${line.verdict === 'block' ? 'text-bad line-through decoration-bad/60' : ''}`}
      >
        {line.text}
      </p>
      {line.fact_ids?.length ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {line.fact_ids.map((id) => (
            <FactChip key={id} id={id} runId={runId} />
          ))}
        </div>
      ) : null}
    </li>
  )
}

function ActiveCall({ call }: { call: CallView }) {
  const now = useNow(1000)
  const endRef = useRef<HTMLLIElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [call.lines.length])
  const secs = Math.max(0, Math.floor((now.getTime() - new Date(call.started_at).getTime()) / 1000))
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-line px-3 py-2">
        <span className="relative flex size-2.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-good/50" />
          <span className="relative inline-flex size-2.5 rounded-full bg-good" />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-[15px] font-semibold text-paper">{call.party_label}</p>
          <p className="text-[12px] text-muted">
            {roleLabel(call.role)} · {call.direction === 'out' ? 'outbound' : 'inbound'}
            {call.handoff ? ' · handed to a person' : ''}
          </p>
        </div>
        {call.test ? <Tag tone="info">test</Tag> : null}
        <span className="num text-[20px] text-paper">{duration(secs)}</span>
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto py-1">
        {call.lines.length === 0 ? (
          <li className="px-3 py-2 text-[13px] text-muted">Connected. Waiting for the first words.</li>
        ) : (
          call.lines.map((l) => <Line key={l.seq} line={l} runId={call.run_id} />)
        )}
        <li ref={endRef} />
      </ol>
    </div>
  )
}

function Approvals() {
  const approvalOrder = useConsole((s) => s.view.approvalOrder)
  const approvals = useConsole((s) => s.view.approvals)
  const pending = useMemo(() => pendingApprovals({ approvalOrder, approvals }), [approvalOrder, approvals])
  const [errors, setErrors] = useState<Record<string, string>>({})
  if (!pending.length) return null

  const decide = (id: string, decision: 'approved' | 'declined') => {
    void operatorPost(`/api/approvals/${encodeURIComponent(id)}`, { decision }, (r) => {
      if (r && !r.ok) setErrors((e) => ({ ...e, [id]: r.message }))
    })
  }

  return (
    <ul className="border-b border-drill/40 bg-drill/[0.06]">
      {pending.map((a) => (
        <li key={a.id} className="flex items-center gap-3 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-[0.12em] text-warn">Needs approval</p>
            <p className="truncate text-[14px] text-paper">
              Call {a.action.party_label} <span className="text-muted">· {roleLabel(a.action.role)}</span>
            </p>
            <p className="truncate text-[12px] text-muted">{errors[a.id] ?? a.action.reason}</p>
          </div>
          <Btn kind="danger" onClick={() => decide(a.id, 'declined')}>
            Decline
          </Btn>
          <Btn kind="primary" onClick={() => decide(a.id, 'approved')}>
            Approve
          </Btn>
        </li>
      ))}
    </ul>
  )
}

export function CallPanel() {
  const activeSid = useConsole((s) => s.view.activeCallSid)
  const call = useConsole((s) => (s.view.activeCallSid ? s.view.calls[s.view.activeCallSid] : undefined))
  const queue = useConsole((s) => s.view.queue)
  const busy = useConsole((s) => s.view.busy)

  return (
    <Panel
      title="Live call"
      aside={
        <>
          {queue.length ? <span className="num">{queue.length} queued</span> : null}
          {busy.length ? <span className="num text-warn">{busy.length} busy-line attempts</span> : null}
          <span>one line at a time</span>
        </>
      }
      className="flex-1"
      bodyClass="flex flex-col"
      delay={180}
    >
      <PhoneBar />
      <Approvals />
      <div className="min-h-0 flex-1">
        {activeSid && call ? (
          <ActiveCall call={call} />
        ) : (
          <EmptyState title="No call in progress">
            Outbound calls wait for operator approval and go one at a time. The public line takes one caller; anyone else hears a short busy message.
          </EmptyState>
        )}
      </div>
      {queue.length ? (
        <ol className="border-t border-line px-3 py-1.5">
          {queue.map((q, i) => (
            <li key={q.call_id} className="flex items-center gap-2 py-0.5 text-[12px]">
              <span className="num text-faint">{i + 1}</span>
              <span className="truncate text-paper-dim">{q.party_label}</span>
              <span className="text-faint">· {roleLabel(q.role)}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </Panel>
  )
}

// the audio element can't send the operator header
function withPasscode(url: string) {
  const pass = operatorPasscode()
  return pass ? `${url}?op=${encodeURIComponent(pass)}` : url
}

export function CallLog() {
  const calls = useConsole((s) => s.view.calls)
  const callOrder = useConsole((s) => s.view.callOrder)
  const artifacts = useConsole((s) => s.view.artifacts)
  const ended = useMemo(() => endedCalls({ calls, callOrder }), [calls, callOrder])

  return (
    <Panel title="Call log" aside={ended.length ? <span className="num">{ended.length} calls</span> : null} className="h-[190px] shrink-0" bodyClass="overflow-y-auto" delay={220}>
      {ended.length === 0 ? (
        <EmptyState compact title="No calls yet">
          Finished calls land here with their outcome and recording.
        </EmptyState>
      ) : (
        <ul>
          {ended.map((c) => {
            const rec = artifacts.findLast((a) => a.type === 'recording' && a.name.includes(c.sid))
            return (
              <li key={c.sid} className="grid grid-cols-[58px_minmax(0,1fr)_auto] items-center gap-2 border-b border-line/50 px-3 py-1.5 text-[13px]">
                <span className="num text-[11px] text-faint">{utcTime(c.started_at)}</span>
                <span className="min-w-0 truncate">
                  <span className="text-paper-dim">{c.party_label}</span>
                  <span className="text-faint"> · {roleLabel(c.role)}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  {c.acknowledged ? <Tag tone="good">ack</Tag> : null}
                  {c.test ? <Tag tone="info">test</Tag> : null}
                  <span className="num text-[12px] text-muted">{c.duration_s !== null ? duration(c.duration_s) : '—'}</span>
                  {rec ? (
                    <a className="text-[12px] text-info hover:underline" href={withPasscode(rec.url)} target="_blank" rel="noreferrer">
                      audio
                    </a>
                  ) : null}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
