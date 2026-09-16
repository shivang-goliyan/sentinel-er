// Just enough markdown for the sitrep: headings, bullets and bold. Everything else stays literal
// text, and React escapes it on the way out.

export type Span = { text: string; bold: boolean }
export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; spans: Span[] }
  | { type: 'list'; items: Span[][] }
  | { type: 'para'; spans: Span[] }

export function spans(line: string): Span[] {
  const out: Span[] = []
  const re = /\*\*(.+?)\*\*/g
  let last = 0
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) out.push({ text: line.slice(last, m.index), bold: false })
    out.push({ text: m[1]!, bold: true })
    last = m.index + m[0].length
  }
  if (last < line.length) out.push({ text: line.slice(last), bold: false })
  return out
}

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) blocks.push({ type: 'para', spans: spans(para.join(' ')) })
    para = []
  }

  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (!line) {
      flush()
      continue
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      blocks.push({ type: 'heading', level: h[1]!.length as 1 | 2 | 3, spans: spans(h[2]!.replace(/\s+#+$/, '')) })
      continue
    }
    const li = /^[-*•]\s+(.*)$/.exec(line)
    if (li) {
      flush()
      const prev = blocks.at(-1)
      if (prev?.type === 'list') prev.items.push(spans(li[1]!))
      else blocks.push({ type: 'list', items: [spans(li[1]!)] })
      continue
    }
    para.push(line)
  }
  flush()
  return blocks
}
