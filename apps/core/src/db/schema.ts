import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// Append-only. Nothing ever updates or deletes a row here.
export const log = sqliteTable(
  'log',
  {
    seq: integer('seq').primaryKey(),
    ts: text('ts').notNull(),
    runId: text('run_id'),
    actor: text('actor').notNull(),
    kind: text('kind').notNull(),
    payload: text('payload').notNull(),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull().unique(),
  },
  (t) => [index('log_run').on(t.runId), index('log_kind').on(t.kind)],
)

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  geometry: text('geometry', { mode: 'json' }).notNull(),
  severity: text('severity', { mode: 'json' }).notNull(),
  sources: text('sources', { mode: 'json' }).notNull(),
  detectedAt: text('detected_at').notNull(),
  ingestedAt: text('ingested_at').notNull(),
  tier: integer('tier').notNull(),
  status: text('status').notNull(),
  isDrill: integer('is_drill', { mode: 'boolean' }).notNull().default(false),
})

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  eventId: text('event_id').notNull(),
  mode: text('mode').notNull(),
  asOf: text('as_of'),
  status: text('status').notNull(),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
})

export const facts = sqliteTable(
  'facts',
  {
    id: text('id').notNull(),
    runId: text('run_id').notNull(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    value: text('value', { mode: 'json' }).notNull(),
    unit: text('unit').notNull(),
    display: text('display').notNull(),
    spoken: text('spoken').notNull(),
    tolerance: text('tolerance', { mode: 'json' }).notNull(),
    source: text('source', { mode: 'json' }).notNull(),
    supersedes: text('supersedes'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.id] }), index('facts_key').on(t.runId, t.key)],
)

export const hospitals = sqliteTable('hospitals', {
  ccn: text('ccn').primaryKey(),
  name: text('name').notNull(),
  address: text('address'),
  city: text('city'),
  state: text('state'),
  zip: text('zip'),
  lat: real('lat'),
  lon: real('lon'),
  phoneMain: text('phone_main'),
  phoneEr: text('phone_er'),
  erHours: text('er_hours'),
  hasEd: integer('has_ed', { mode: 'boolean' }),
  traumaLevel: text('trauma_level'),
  beds: integer('beds'),
  certifiedBeds: integer('certified_beds'),
  website: text('website'),
  overflowCcn: text('overflow_ccn'),
  updatedAt: text('updated_at').notNull(),
})

export const hospitalFields = sqliteTable(
  'hospital_fields',
  {
    ccn: text('ccn').notNull(),
    field: text('field').notNull(),
    value: text('value', { mode: 'json' }),
    sourceName: text('source_name').notNull(),
    sourceUrl: text('source_url'),
    confidence: real('confidence').notNull(),
    retrievedAt: text('retrieved_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.ccn, t.field, t.sourceName] })],
)

export const calls = sqliteTable('calls', {
  sid: text('sid').primaryKey(),
  runId: text('run_id'),
  direction: text('direction').notNull(),
  role: text('role').notNull(),
  partyLabel: text('party_label').notNull(),
  toMasked: text('to_masked'),
  fromMasked: text('from_masked'),
  status: text('status').notNull(),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
  ackAt: text('ack_at'),
  recordingUrl: text('recording_url'),
  test: integer('test', { mode: 'boolean' }).notNull().default(false),
})

// Only numbers on this list can ever be dialled. Real hospital numbers never go here.
export const whitelist = sqliteTable('whitelist', {
  e164: text('e164').primaryKey(),
  label: text('label').notNull(),
  role: text('role').notNull(),
  consentAt: text('consent_at').notNull(),
  consentBy: text('consent_by').notNull(),
})

export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  runId: text('run_id'),
  action: text('action', { mode: 'json' }).notNull(),
  requestedAt: text('requested_at').notNull(),
  decidedAt: text('decided_at'),
  decision: text('decision'),
  decidedBy: text('decided_by'),
})

export const predictions = sqliteTable('predictions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: text('run_id').notNull(),
  model: text('model').notNull(),
  version: text('version').notNull(),
  inputs: text('inputs', { mode: 'json' }).notNull(),
  outputs: text('outputs', { mode: 'json' }).notNull(),
  createdAt: text('created_at').notNull(),
})

export const grades = sqliteTable('grades', {
  runId: text('run_id').primaryKey(),
  truth: text('truth', { mode: 'json' }).notNull(),
  score: text('score', { mode: 'json' }).notNull(),
  createdAt: text('created_at').notNull(),
})

export const anchors = sqliteTable('anchors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  headSeq: integer('head_seq').notNull(),
  headHash: text('head_hash').notNull(),
  proof: text('proof').notNull(),
  submittedAt: text('submitted_at').notNull(),
  confirmedAt: text('confirmed_at'),
  blockHeight: integer('block_height'),
})
