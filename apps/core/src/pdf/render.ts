import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Fact } from '@sentinel/shared'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Just enough markdown for a sitrep: headings, bullets, bold, paragraphs.
export function markdownToHtml(md: string): string {
  const out: string[] = []
  let inList = false
  const inline = (t: string) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  const closeList = () => {
    if (inList) out.push('</ul>')
    inList = false
  }
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      closeList()
      continue
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) {
      closeList()
      const level = Math.min(h[1]!.length, 4)
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`)
      continue
    }
    const li = line.match(/^\s*[-*]\s+(.*)$/)
    if (li) {
      if (!inList) out.push('<ul>')
      inList = true
      out.push(`<li>${inline(li[1]!)}</li>`)
      continue
    }
    closeList()
    out.push(`<p>${inline(line)}</p>`)
  }
  closeList()
  return out.join('\n')
}

export function sitrepHtml(opts: { text: string; title: string; generatedAt: string; facts: Fact[]; template: boolean }) {
  const sources = [...new Map(opts.facts.map((f) => [f.source.name, f.source])).values()]
  const body = markdownToHtml(opts.text.replace(/^DRILL — Sentinel ER situation report\s*/i, ''))
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(opts.title)}</title><style>
  @page { size: Letter; margin: 14mm 14mm 16mm; }
  body { font: 10.5pt/1.45 "Helvetica Neue", Arial, sans-serif; color: #111; }
  .drill { background: repeating-linear-gradient(-45deg,#f3b63c 0 10px,#1b1b1b 10px 20px); color:#000; padding: 3px; }
  .drill div { background:#f3b63c; font-weight:800; letter-spacing:.18em; text-align:center; padding:4px 0; }
  header { display:flex; justify-content:space-between; align-items:baseline; border-bottom: 2px solid #111; margin: 10px 0 8px; padding-bottom: 6px; }
  header h1 { font-size: 17pt; margin: 0; }
  header p { margin: 0; color:#444; font-size: 9pt; text-align:right; }
  h2 { font-size: 11.5pt; text-transform: uppercase; letter-spacing: .06em; border-bottom: 1px solid #bbb; margin: 12px 0 4px; padding-bottom: 2px; }
  h3, h4 { font-size: 10.5pt; margin: 8px 0 2px; }
  ul { margin: 2px 0 6px 16px; padding: 0; } li { margin: 1px 0; } p { margin: 3px 0; }
  footer { margin-top: 12px; border-top: 1px solid #bbb; padding-top: 6px; font-size: 8pt; color:#444; }
  footer li { margin: 0; }
  </style></head><body>
  <div class="drill"><div>DRILL — NOT A REAL EVENT</div></div>
  <header><h1>${esc(opts.title)}</h1><p>Sentinel ER situation report<br>Generated ${esc(opts.generatedAt)}${opts.template ? ' · template' : ''}</p></header>
  ${body}
  <footer><strong>Sources.</strong> Every figure above was checked against its source before this report was produced.
  <ul>${sources.map((s) => `<li>${esc(s.name)}${s.url ? ` — ${esc(s.url)}` : ''}</li>`).join('')}</ul>
  Casualty figures are screening estimates with a range. No patient information is used.</footer>
  </body></html>`
}

export async function renderPdf(html: string, outDir: string, name: string): Promise<{ path: string; bytes: number }> {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'load' })
    const pdf = await page.pdf({ format: 'Letter', printBackground: true })
    await mkdir(outDir, { recursive: true })
    const path = join(outDir, name)
    await writeFile(path, pdf)
    return { path, bytes: pdf.length }
  } finally {
    // one render at a time and the browser goes away after; the box has other services on it
    await browser.close()
  }
}
