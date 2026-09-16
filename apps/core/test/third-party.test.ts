import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { repoRoot } from '../src/config.ts'

// The event rules say every library and API must be declared. This keeps THIRD_PARTY.md honest.
const declared = readFileSync(join(repoRoot, 'THIRD_PARTY.md'), 'utf8')
const json = (f: string) => JSON.parse(readFileSync(join(repoRoot, f), 'utf8'))

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.venv' || name === 'dist' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* files(p)
    else if (/\.(ts|tsx|py)$/.test(name)) yield p
  }
}

describe('third-party declarations', () => {
  it('lists every npm package', () => {
    const missing: string[] = []
    for (const f of ['package.json', 'apps/core/package.json', 'apps/console/package.json', 'packages/shared/package.json']) {
      const p = json(f)
      for (const name of Object.keys({ ...p.dependencies, ...p.devDependencies })) {
        if (!name.startsWith('@sentinel/') && !declared.includes(name)) missing.push(name)
      }
    }
    expect(missing).toEqual([])
  })

  it('lists every python package', () => {
    const toml = readFileSync(join(repoRoot, 'pyproject.toml'), 'utf8')
    const block = /dependencies = \[([\s\S]*?)\]/.exec(toml)![1]!
    const names = [...block.matchAll(/"([a-zA-Z0-9_-]+)/g)].map((m) => m[1]!)
    expect(names.length).toBeGreaterThan(5)
    expect(names.filter((n) => !declared.includes(n))).toEqual([])
  })

  it('lists every host we call', () => {
    const hosts = new Set<string>()
    for (const dir of ['apps/core/src', 'apps/console/src', 'services', 'scripts', 'ml', 'packages']) {
      for (const f of files(join(repoRoot, dir))) {
        for (const m of readFileSync(f, 'utf8').matchAll(/\b(?:https?|wss?):\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) hosts.add(m[1]!.toLowerCase())
      }
    }
    expect(hosts.size).toBeGreaterThan(20)
    expect([...hosts].filter((h) => !declared.includes(h)).sort()).toEqual([])
  })
})
