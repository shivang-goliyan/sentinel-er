import { fileURLToPath } from 'node:url'
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

const flag = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes')

const Env = z.object({
  NODE_ENV: z.string().default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(8080),
  PUBLIC_BASE_URL: z.string().default('http://127.0.0.1:8080'),
  OPERATOR_PASSCODE: z.string().optional(),
  DRILL: flag.default(true),
  APPROVAL_DEFAULT: flag.default(true),
  DEMO_INJECT_FAULT: z.string().default(''),
  DATABASE_PATH: z.string().default('data/sentinel.db'),
  TAPE_DIR: z.string().default('data/tapes'),
  TAPE_MODE_DEFAULT: z.enum(['live', 'record', 'replay', 'live-with-fallback']).default('live-with-fallback'),
  SCIENCE_URL: z.string().default('http://127.0.0.1:8001'),
  LLM_CHAIN_VOICE: z.string().default('gemini:gemini-3.5-flash-lite,groq:openai/gpt-oss-20b'),
  LLM_CHAIN_TEXT: z.string().default('gemini:gemini-3.5-flash,groq:openai/gpt-oss-120b'),
  TIER2_MIN_POP: z.coerce.number().default(10000),
  DAMAGE_MMI: z.coerce.number().default(7),
  VOICE_RECORD: flag.default(true),
  // off until Phase 0 shows <Start><Stream> works next to ConversationRelay
  VOICE_LISTEN: flag.default(false),
})

export type Config = z.infer<typeof Env> & { operatorPasscode: string; databasePath: string; tapeDir: string }

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
    throw new Error(`bad environment:\n${lines.join('\n')}`)
  }
  const c = parsed.data
  let passcode = c.OPERATOR_PASSCODE
  if (!passcode) {
    if (c.NODE_ENV === 'production') throw new Error('OPERATOR_PASSCODE has to be set in production')
    passcode = 'drill-only-dev'
    console.warn('OPERATOR_PASSCODE not set, using the dev passcode')
  }
  const inRepo = (p: string) => (p === ':memory:' || isAbsolute(p) ? p : resolve(repoRoot, p))
  return { ...c, operatorPasscode: passcode, databasePath: inRepo(c.DATABASE_PATH), tapeDir: inRepo(c.TAPE_DIR) }
}
