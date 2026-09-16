import { describe, expect, it } from 'vitest'
import { parseMarkdown, spans } from '../src/lib/markdown'

describe('sitrep markdown', () => {
  it('parses headings and bullets', () => {
    const blocks = parseMarkdown('DRILL — Sentinel ER situation report\n\n## Incident\n- Magnitude: M6.4\n- Depth: 8 km\n\nClosing line')
    expect(blocks.map((b) => b.type)).toEqual(['para', 'heading', 'list', 'para'])
    const list = blocks[2]
    expect(list?.type === 'list' && list.items.length).toBe(2)
  })

  it('splits bold spans', () => {
    expect(spans('Beds **312** at **Inova**')).toEqual([
      { text: 'Beds ', bold: false },
      { text: '312', bold: true },
      { text: ' at ', bold: false },
      { text: 'Inova', bold: true },
    ])
    expect(spans('an ** unclosed')).toEqual([{ text: 'an ** unclosed', bold: false }])
  })

  it('keeps html as text', () => {
    const [b] = parseMarkdown('<img src=x onerror=alert(1)> [link](javascript:x) `code`')
    expect(b).toEqual({
      type: 'para',
      spans: [{ text: '<img src=x onerror=alert(1)> [link](javascript:x) `code`', bold: false }],
    })
  })

  it('joins wrapped paragraph lines', () => {
    const [b] = parseMarkdown('first half\nsecond half')
    expect(b?.type === 'para' && b.spans[0]?.text).toBe('first half second half')
  })

  it('treats deep headings literally', () => {
    const [b] = parseMarkdown('#### too deep')
    expect(b?.type).toBe('para')
    const [h] = parseMarkdown('### Access ##')
    expect(h).toEqual({ type: 'heading', level: 3, spans: [{ text: 'Access', bold: false }] })
  })
})
