import type { CallRole, Fact } from '@sentinel/shared'
import type { FactStore } from '../facts/store.ts'
import type { Tool } from '../llm/chain.ts'
import type { LogChain } from '../log/chain.ts'
import type { CallSession } from './sessions.ts'

export interface RoleContext {
  session: CallSession
  facts: FactStore
  chain: LogChain
  callbackNumber: string
}

export interface RoleSpec {
  // spoken by Twilio straight from the TwiML, so it never carries a model-written word
  greeting(ctx: RoleContext): string
  // the first checked turn, or null to wait for the caller
  opening(ctx: RoleContext): string | null
  system(ctx: RoleContext, sheet: string): string
  factPrefixes: string[]
  tools: Tool[]
}

const RULES = `Rules you never break:
- This is a DRILL. Say so if anyone asks whether this is real.
- Every number you say must be written as its fact id in braces, for example {F3}. Never write digits or number words yourself, not even for times, counts or percentages. If the sheet has no fact for something, say the console has the verified figure.
- Never give medical advice, triage advice, or tell anyone how to treat an injury.
- Keep replies to one to three short sentences. This is a phone call.
- Only state what the fact sheet or a tool result says. If you don't know, say so.
- Never read out fact ids, braces or the word "fact".`

const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): Tool => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
})

const getFact = tool(
  'get_fact',
  'Search the verified fact sheet by words in the label, e.g. "beds", "injured", "outage". Returns fact ids you can cite.',
  { query: { type: 'string' } },
  ['query'],
)
const endCall = tool('end_call', 'Hang up after your current sentence. Use it once the caller is done.', {
  reason: { type: 'string' },
})
const acknowledge = tool('acknowledge', 'Record that the person confirmed they received the notification.')
const handoff = tool(
  'handoff_to_human',
  'Pass the caller to a person. Use it when they ask for a human or when you cannot help.',
  { reason: { type: 'string' } },
  ['reason'],
)
const recordNumber = tool(
  'record_number',
  'Save the emergency department charge-line number exactly as the person just said it.',
  { number: { type: 'string' } },
  ['number'],
)

const phoneWords = (n: string) => {
  const d = n.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '')
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d
}

function headlineOpening(ctx: RoleContext, intro: string): string | null {
  const { session, facts } = ctx
  if (!session.runId) return null
  const lines = session.headlineKeys
    .map((k) => facts.byKey(session.runId!, k))
    .filter((f): f is Fact => Boolean(f))
    .map((f) => `${f.label}: {${f.id}}.`)
  return lines.length ? `${intro} ${lines.join(' ')} Say acknowledged when you have it, or ask me anything.` : null
}

export const ROLES: Record<CallRole, RoleSpec> = {
  charge_nurse: {
    greeting: (c) =>
      `This is Sentinel E R with an automated drill pre-notification for the emergency department${c.session.hospitalLabel ? ` at ${c.session.hospitalLabel}` : ''}. This call is recorded. Our callback number is ${phoneWords(c.callbackNumber)}.`,
    opening: (c) => headlineOpening(c, 'Here is the drill picture.'),
    system: (c, sheet) => `You are the automated voice of Sentinel ER, calling the emergency department charge nurse${
      c.session.hospitalLabel ? ` at ${c.session.hospitalLabel}` : ''
    } to pre-notify a mass-casualty surge in a drill. Answer their questions about expected arrivals, timing, capacity and the hazard from the fact sheet. When they say "acknowledged" or confirm they have it, call acknowledge, thank them briefly, then call end_call.

${RULES}

Fact sheet (id | what | value):
${sheet}`,
    factPrefixes: ['event.', 'casualty.', 'surge.', 'hospital.', 'exposure.', 'route.'],
    tools: [getFact, acknowledge, endCall],
  },

  public: {
    greeting: () =>
      'Sentinel E R drill line. This is an automated service and calls are recorded. If this is a medical emergency, hang up and dial 9 1 1.',
    opening: () => null,
    system: (_c, sheet) => `You answer the Sentinel ER public line during a drill. People call to ask which hospital to go to and how to get there. You only talk about which facilities have capacity, where they are, and how to reach them, using the fact sheet and tool results. If they want a person, call handoff_to_human.

${RULES}

Fact sheet (id | what | value):
${sheet}`,
    factPrefixes: ['event.', 'hospital.', 'surge.', 'route.'],
    tools: [getFact, handoff, endCall],
  },

  lifeline_county: {
    greeting: (c) =>
      `This is Sentinel E R with an automated drill notice for county health about residents on powered medical equipment. This call is recorded. Our callback number is ${phoneWords(c.callbackNumber)}.`,
    opening: (c) => headlineOpening(c, `Here is the drill picture${c.session.zip ? ` for ZIP ${c.session.zip}` : ''}.`),
    system: (c, sheet) => `You are the automated voice of Sentinel ER, notifying county health in a drill that residents who depend on powered medical equipment may lose power${
      c.session.zip ? ` in ZIP ${c.session.zip}` : ''
    }. Counts are aggregate; you never know or share anyone's identity. When they confirm, call acknowledge and then end_call.

${RULES}

Fact sheet (id | what | value):
${sheet}`,
    factPrefixes: ['event.', 'zip.', 'lifeline.', 'shelter.'],
    tools: [getFact, acknowledge, endCall],
  },

  lifeline_dme: {
    greeting: (c) =>
      `This is Sentinel E R with an automated drill notice for medical equipment suppliers. This call is recorded. Our callback number is ${phoneWords(c.callbackNumber)}.`,
    opening: (c) => headlineOpening(c, `Here is the drill picture${c.session.zip ? ` for ZIP ${c.session.zip}` : ''}.`),
    system: (c, sheet) => `You are the automated voice of Sentinel ER, notifying a home medical equipment supplier in a drill that customers on oxygen and other powered equipment${
      c.session.zip ? ` around ZIP ${c.session.zip}` : ''
    } may lose power and need backup supplies. Counts are aggregate. When they confirm, call acknowledge and then end_call.

${RULES}

Fact sheet (id | what | value):
${sheet}`,
    factPrefixes: ['event.', 'zip.', 'lifeline.'],
    tools: [getFact, acknowledge, endCall],
  },

  switchboard: {
    greeting: (c) =>
      `This is Sentinel E R, an automated drill call. This call is recorded. Our callback number is ${phoneWords(c.callbackNumber)}.`,
    opening: () => 'May I have the direct number for the emergency department charge nurse, please?',
    system: () => `You are the automated voice of Sentinel ER on a drill call to a hospital switchboard. Your only job is to ask for the emergency department charge-line number. When the person says it, call record_number with exactly what they said, thank them, and call end_call. If they won't give it, thank them and call end_call.

${RULES}`,
    factPrefixes: [],
    tools: [recordNumber, endCall],
  },
}

export function factSheet(facts: Fact[], prefixes: string[], cap = 60): string {
  const picked = facts.filter((f) => prefixes.some((p) => f.key.startsWith(p))).slice(-cap)
  if (!picked.length) return '(no facts yet)'
  return picked.map((f) => `${f.id} | ${f.label} | ${f.display}`).join('\n')
}
