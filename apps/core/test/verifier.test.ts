import { describe, expect, it } from 'vitest'
import type { Fact } from '@sentinel/shared'
import { findNumbers } from '../src/facts/numbers.ts'
import { SAFE_LINE, injectWrongNumber, quoteOnPage, verify } from '../src/facts/verifier.ts'
import { makeDeps } from './helpers.ts'

const src = { name: 'FEMA Hospitals RAPT', retrieved_at: '2026-09-16T00:00:00Z', method: 'dataset' as const }

function facts() {
  const { facts: store } = makeDeps()
  const beds = store.add('r1', { key: 'hospital.inova-alex.beds', label: 'Inova Alexandria beds', value: 312, unit: 'beds', source: src })
  const outage = store.add('r1', {
    key: 'zip.22314.outage_probability',
    label: 'Outage chance, 22314',
    value: 0.41,
    unit: 'probability',
    source: { ...src, method: 'model' },
  })
  const zip = store.add('r1', { key: 'zip.22314.code', label: 'ZIP', value: '22314', unit: 'text', source: src })
  return { store, beds, outage, zip, all: () => store.all('r1') }
}

describe('findNumbers', () => {
  it('reads digits and separators', () => {
    expect(findNumbers('312 beds, 1,204 people, 3.5 hours').map((n) => n.value)).toEqual([312, 1204, 3.5])
  })

  it('reads number words', () => {
    expect(findNumbers('three hundred and twelve beds').map((n) => n.value)).toEqual([312])
    expect(findNumbers('twenty-one arrivals').map((n) => n.value)).toEqual([21])
  })

  it('ignores the pronoun one', () => {
    expect(findNumbers('Inova is the one filling first')).toHaveLength(0)
  })

  it('catches percents and times', () => {
    const found = findNumbers('41 percent by 02:00')
    expect(found.map((n) => [n.kind, n.value])).toEqual([
      ['percent', 41],
      ['time', 120],
    ])
  })

  it('flags vague amounts', () => {
    expect(findNumbers('hundreds of casualties')[0]).toMatchObject({ kind: 'vague', value: null })
  })
})

describe('verify', () => {
  it('renders cited facts', () => {
    const { beds, all } = facts()
    const r = verify(`Inova has {${beds.id}} beds.`, all(), 'sitrep')
    expect(r).toMatchObject({ rendered: 'Inova has 312 beds.', verdict: 'pass', factIds: [beds.id] })
  })

  it('blocks unknown fact ids', () => {
    const { all } = facts()
    expect(verify('Inova has {F99} beds.', all(), 'sitrep').verdict).toBe('block')
  })

  it('blocks any bare number in a sitrep', () => {
    const { all } = facts()
    const r = verify('Inova has 312 beds.', all(), 'sitrep')
    expect(r.verdict).toBe('block')
    expect(r.findings[0]).toMatchObject({ kind: 'bare_number', expected: '312' })
  })

  it('lets a matching spoken number through', () => {
    const { all } = facts()
    const r = verify('Inova has three hundred twelve beds.', all(), 'voice')
    expect(r.verdict).toBe('pass_with_note')
    expect(r.rendered).toBe('Inova has three hundred twelve beds.')
  })

  it('replaces a wrong spoken number', () => {
    const { all } = facts()
    const r = verify('Inova has 450 beds.', all(), 'voice')
    expect(r).toMatchObject({ verdict: 'block', rendered: SAFE_LINE })
  })

  it('matches probabilities said as percents', () => {
    const { all } = facts()
    expect(verify('About 41 percent chance of an outage.', all(), 'voice').verdict).toBe('pass_with_note')
  })

  it('matches numbers inside text facts', () => {
    const { all } = facts()
    expect(verify('That is ZIP 22314.', all(), 'voice').verdict).toBe('pass_with_note')
  })

  it('drops a repeated unit', () => {
    const { store, all } = facts()
    const depth = store.add('r1', { key: 'event.depth_km', label: 'Depth', value: 6, unit: 'km', display: '6 km', source: src })
    const pct = store.add('r1', { key: 'x.pct', label: 'Change', value: 41, unit: 'percent', display: '41%', source: src })
    expect(verify(`At {${depth.id}} km depth, up {${pct.id}}% today.`, all(), 'sitrep').rendered).toBe('At 6 km depth, up 41% today.')
    expect(verify(`It sits {${depth.id}} kmh away and {${depth.id}} below.`, all(), 'sitrep').rendered).toBe('It sits 6 km kmh away and 6 km below.')
  })

  it('reads phone numbers by group', () => {
    const { store, all } = facts()
    store.add('r1', { key: 'hospital.inova-alex.phone', label: 'Inova Alexandria main line', value: '(703) 504-3000', unit: 'text', source: src })
    store.add('r1', { key: 'system.callback', label: 'Callback', value: '+15715550100', unit: 'text', source: src })
    expect(verify('Call 703-504-3000 or 571-555-0100.', all(), 'voice').verdict).toBe('pass_with_note')
    expect(verify('Their line is 7035043000.', all(), 'voice').verdict).toBe('pass_with_note')
    const v = verify('Inova Alexandria has 430 beds.', all(), 'voice')
    expect(v.verdict).toBe('block')
    expect(v.findings[0]).toMatchObject({ fact_id: expect.stringMatching(/^F/), expected: '312' })
  })

  it('never blocks nine one one', () => {
    const { all } = facts()
    expect(verify('Hang up and dial 911 now.', all(), 'voice').verdict).toBe('pass')
  })

  it('uses current values only', () => {
    const { store, all } = facts()
    store.add('r1', { key: 'hospital.inova-alex.beds', label: 'Inova Alexandria beds', value: 290, unit: 'beds', source: src })
    expect(verify('Inova has 312 beds.', all(), 'voice').verdict).toBe('block')
    expect(verify('Inova has 290 beds.', all(), 'voice').verdict).toBe('pass_with_note')
  })

  it('catches the injected wrong count', () => {
    const { beds, all } = facts()
    const { text, wrong } = injectWrongNumber(`Inova has {${beds.id}} beds.`, beds)
    expect(wrong).not.toBe(312)
    const r = verify(text, all(), 'sitrep')
    expect(r.verdict).toBe('block')
    expect(r.findings[0]).toMatchObject({ kind: 'bare_number', text: String(wrong) })
  })
})

describe('quoteOnPage', () => {
  it('finds quotes despite whitespace', () => {
    expect(quoteOnPage('Level II   Trauma Center', 'Inova is a\nLevel II Trauma Center serving')).toBe(true)
  })

  it('rejects invented quotes', () => {
    expect(quoteOnPage('Level I Trauma Center', 'Inova is a Level II Trauma Center')).toBe(false)
  })
})

describe('fact store', () => {
  it('supersedes by key', () => {
    const { store, beds } = facts()
    const next = store.add('r1', { key: beds.key, label: beds.label, value: 300, unit: 'beds', source: src })
    expect(next.supersedes).toBe(beds.id)
    expect(store.byKey('r1', beds.key)?.value).toBe(300)
    expect(store.latest('r1').filter((f: Fact) => f.key === beds.key)).toHaveLength(1)
  })

  it('logs every new fact', () => {
    const { chain, facts: store } = makeDeps()
    store.add('r2', { key: 'k', label: 'k', value: 1, unit: 'count', source: src })
    expect(chain.after(0).map((e) => e.kind)).toEqual(['fact'])
  })
})
