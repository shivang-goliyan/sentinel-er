import { z } from 'zod'

export const FactUnit = z.enum([
  'beds',
  'people',
  'minutes',
  'hours',
  'days',
  'percent',
  'probability',
  'mmi',
  'g',
  'km',
  'magnitude',
  'count',
  'text',
])
export type FactUnit = z.infer<typeof FactUnit>

export const FactSource = z.object({
  name: z.string(),
  url: z.string().optional(),
  retrieved_at: z.string(),
  method: z.enum(['api', 'model', 'computed', 'extracted', 'operator', 'dataset']),
})
export type FactSource = z.infer<typeof FactSource>

export const Tolerance = z.object({
  abs: z.number().optional(),
  rel: z.number().optional(),
})

export const Fact = z.object({
  id: z.string().regex(/^F[0-9a-z]+$/),
  run_id: z.string(),
  key: z.string(),
  label: z.string(),
  value: z.union([z.number(), z.string()]),
  unit: FactUnit,
  display: z.string(),
  spoken: z.string(),
  tolerance: Tolerance.default({}),
  source: FactSource,
  supersedes: z.string().nullable().default(null),
  created_at: z.string(),
})
export type Fact = z.infer<typeof Fact>

export const FindingKind = z.enum(['unknown_fact', 'bare_number', 'uncited_match', 'quote_missing', 'injected'])

export const Finding = z.object({
  kind: FindingKind,
  text: z.string(),
  fact_id: z.string().optional(),
  expected: z.string().optional(),
  source: FactSource.optional(),
})
export type Finding = z.infer<typeof Finding>

export const VerifyChannel = z.enum(['sitrep', 'voice', 'extraction'])
export type VerifyChannel = z.infer<typeof VerifyChannel>
