import type { Actor, CallRole, LogEntry, Milestone } from '@sentinel/shared'

export const MILESTONES: Milestone[] = [
  'detected',
  'context_built',
  'casualties_estimated',
  'surge_forecast',
  'lifeline_ready',
  'sitrep_written',
  'verified',
  'approved',
  'call_placed',
  'acknowledged',
]

const milestoneNames: Record<Milestone, string> = {
  detected: 'Detected',
  context_built: 'Context',
  casualties_estimated: 'Casualties',
  surge_forecast: 'Surge',
  lifeline_ready: 'Lifeline',
  sitrep_written: 'Sitrep',
  verified: 'Verified',
  approved: 'Approved',
  call_placed: 'Call placed',
  acknowledged: 'Acknowledged',
}

export const milestoneLabel = (m: Milestone) => milestoneNames[m]

const actorNames: Record<Actor, string> = {
  orchestrator: 'Orchestrator',
  scout: 'Scout',
  analyst: 'Analyst',
  logistics: 'Logistics',
  comms: 'Comms',
  verifier: 'Verifier',
  feeds: 'Feeds',
  operator: 'Operator',
  system: 'System',
}

export const actorLabel = (a: Actor) => actorNames[a]

const actorJobs: Partial<Record<Actor, string>> = {
  orchestrator: 'Runs the crew and the approval gate',
  scout: 'Builds hospital profiles from public sources',
  analyst: 'Models casualties and writes the sitrep',
  logistics: 'Routes and survey flight plans',
  comms: 'Places and answers calls',
  verifier: 'Checks every number before it leaves',
  feeds: 'Watches USGS, NASA, GDACS, NOAA',
}

export const actorJob = (a: Actor) => actorJobs[a] ?? ''

const roleNames: Record<CallRole, string> = {
  charge_nurse: 'ED charge nurse',
  public: 'Public line',
  lifeline_county: 'County health',
  lifeline_dme: 'Equipment supplier',
  switchboard: 'Hospital switchboard',
}

export const roleLabel = (r: CallRole | string) => roleNames[r as CallRole] ?? r

function ms(iso: string) {
  return new Date(iso).getTime()
}

// T+m:ss from the run's detection; T+h:mm:ss once past an hour
export function tPlus(fromIso: string, toIso: string): string {
  let secs = Math.max(0, Math.floor((ms(toIso) - ms(fromIso)) / 1000))
  const h = Math.floor(secs / 3600)
  secs -= h * 3600
  const m = Math.floor(secs / 60)
  const s = String(secs - m * 60).padStart(2, '0')
  return h > 0 ? `T+${h}:${String(m).padStart(2, '0')}:${s}` : `T+${m}:${s}`
}

export function duration(totalSecs: number): string {
  const m = Math.floor(totalSecs / 60)
  const s = String(Math.floor(totalSecs % 60)).padStart(2, '0')
  return `${m}:${s}`
}

export function clock(d: Date, timeZone?: string): string {
  return d.toLocaleTimeString('en-GB', { hour12: false, timeZone })
}

export function zoneName(timeZone?: string): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
    .formatToParts(new Date())
    .find((p) => p.type === 'timeZoneName')
  return part?.value ?? ''
}

export function utcTime(iso: string): string {
  return new Date(iso).toISOString().slice(11, 19)
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export type Tone = 'plain' | 'good' | 'warn' | 'bad' | 'info' | 'quiet'

export type FeedLine = { tag: string; text: string; tone: Tone }

function clip(text: string, n = 140) {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text
}

export function feedLine(e: LogEntry): FeedLine {
  switch (e.kind) {
    case 'event.detected':
      return { tag: 'event', text: e.payload.event.title, tone: e.payload.event.is_drill ? 'warn' : 'info' }
    case 'event.tiered':
      return { tag: 'tier', text: `Tier ${e.payload.tier} — ${e.payload.reason}`, tone: e.payload.tier >= 2 ? 'warn' : 'plain' }
    case 'run.started':
      return { tag: 'run', text: `Run started: ${e.payload.title}`, tone: 'info' }
    case 'run.ended':
      return {
        tag: 'run',
        text: `Run ${e.payload.status}${e.payload.note ? ` — ${e.payload.note}` : ''}`,
        tone: e.payload.status === 'failed' ? 'bad' : 'plain',
      }
    case 'status':
      return { tag: actorLabel(e.actor).toLowerCase(), text: e.payload.text, tone: e.payload.state === 'error' ? 'bad' : 'quiet' }
    case 'ledger':
      return { tag: 'ledger', text: milestoneLabel(e.payload.milestone), tone: 'good' }
    case 'fact': {
      const f = e.payload.fact
      return { tag: 'fact', text: `${f.id} ${f.label}: ${f.display} (${f.source.name})`, tone: 'plain' }
    }
    case 'fetch':
      return {
        tag: 'fetch',
        text: `${e.payload.status} ${e.payload.source} ${clip(e.payload.url, 90)}${e.payload.from_tape ? ' · from tape' : ''}`,
        tone: e.payload.status >= 400 ? 'bad' : 'quiet',
      }
    case 'model.output':
      return { tag: 'model', text: `${e.payload.model} ${e.payload.version} returned`, tone: 'plain' }
    case 'sitrep.draft':
      return { tag: 'sitrep', text: `Draft ${e.payload.attempt} written`, tone: 'plain' }
    case 'verify.pass':
      return { tag: 'verify', text: `Passed ${e.payload.channel}: ${e.payload.target}`, tone: 'good' }
    case 'verify.block': {
      const first = e.payload.findings[0]
      return {
        tag: 'blocked',
        text: `Blocked ${e.payload.channel}: ${first ? clip(first.text, 90) : e.payload.target}`,
        tone: 'bad',
      }
    }
    case 'sitrep.final':
      return { tag: 'sitrep', text: e.payload.template ? 'Sitrep final (template)' : 'Sitrep final', tone: 'good' }
    case 'artifact':
      return { tag: 'file', text: e.payload.name, tone: 'info' }
    case 'approval.requested':
      return {
        tag: 'approval',
        text: `Needs approval: call ${e.payload.action.party_label}`,
        tone: 'warn',
      }
    case 'approval.decided':
      return {
        tag: 'approval',
        text: `${e.payload.decision === 'approved' ? 'Approved' : 'Declined'} by ${e.payload.by}`,
        tone: e.payload.decision === 'approved' ? 'good' : 'bad',
      }
    case 'call.queued':
      return { tag: 'call', text: `Queued: ${e.payload.party_label}`, tone: 'plain' }
    case 'call.started':
      return {
        tag: 'call',
        text: `${e.payload.direction === 'out' ? 'Calling' : 'Answered'} ${e.payload.party_label}${e.payload.test ? ' (test)' : ''}`,
        tone: 'info',
      }
    case 'call.heard':
      return { tag: 'heard', text: `“${clip(e.payload.text)}”`, tone: 'plain' }
    case 'call.said':
      return {
        tag: 'said',
        text: clip(e.payload.text),
        tone: e.payload.verdict === 'block' ? 'bad' : e.payload.verdict === 'pass_with_note' ? 'warn' : 'plain',
      }
    case 'call.tool':
      return { tag: 'tool', text: `${e.payload.tool}: ${clip(e.payload.summary, 100)}`, tone: 'quiet' }
    case 'call.handoff':
      return { tag: 'handoff', text: `Handed to a person — ${e.payload.reason}`, tone: 'warn' }
    case 'call.busy':
      return { tag: 'busy', text: `Line busy for ${e.payload.from_label}`, tone: 'warn' }
    case 'call.ended':
      return {
        tag: 'call',
        text: `Call ended (${e.payload.status}, ${duration(e.payload.duration_s)})${e.payload.acknowledged ? ' · acknowledged' : ''}`,
        tone: 'plain',
      }
    case 'capacity.updated':
      return { tag: 'capacity', text: `${e.payload.ccn}: ${e.payload.reserved} reserved — ${e.payload.reason}`, tone: 'plain' }
    case 'anchor.submitted':
      return { tag: 'anchor', text: `Chain head #${e.payload.head_seq} sent to OpenTimestamps`, tone: 'info' }
    case 'anchor.confirmed':
      return {
        tag: 'anchor',
        text: `Head #${e.payload.head_seq} confirmed${e.payload.block_height ? ` in Bitcoin block ${e.payload.block_height}` : ''}`,
        tone: 'good',
      }
    case 'fallback.used':
      return { tag: 'fallback', text: `${e.payload.source} served from tape — ${e.payload.reason}`, tone: 'warn' }
    case 'fault.injected':
      return { tag: 'injected', text: `Injected on purpose: ${e.payload.detail}`, tone: 'warn' }
    case 'switch.changed':
      return {
        tag: 'switch',
        text: `${e.payload.name === 'approval' ? 'Human approval' : 'Drill mode'} ${e.payload.on ? 'on' : 'off'}`,
        tone: 'info',
      }
    case 'whitelist.changed':
      return {
        tag: 'whitelist',
        text: `${e.payload.removed ? 'Removed' : 'Added'} ${e.payload.label} (${e.payload.masked})`,
        tone: 'plain',
      }
    case 'note':
      return { tag: 'note', text: e.payload.text, tone: 'plain' }
    case 'error':
      return { tag: 'error', text: `${e.payload.where}: ${e.payload.message}`, tone: 'bad' }
  }
}
