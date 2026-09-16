const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

export interface StreamTwiml {
  base: string // https://host
  callRef: string
  record: boolean
  webhookQuery?: string // "k=..." when signatures aren't available
}

const wss = (base: string) => base.replace(/^http/, 'ws')

// A two-way media stream: the call's audio comes to us, and we send our speech back down it.
export function streamTwiml(o: StreamTwiml): string {
  const q = o.webhookQuery ? `?${o.webhookQuery}` : ''
  const parts = ['<?xml version="1.0" encoding="UTF-8"?><Response>']
  if (o.record) {
    parts.push(
      `<Start><Recording channels="dual" recordingStatusCallback="${esc(o.base)}/voice/recording${esc(q)}" recordingStatusCallbackEvent="completed"/></Start>`,
    )
  }
  parts.push(
    `<Connect><Stream url="${esc(wss(o.base))}/voice/media">`,
    `<Parameter name="callRef" value="${esc(o.callRef)}"/>`,
    '</Stream></Connect></Response>',
  )
  return parts.join('')
}

export function sayAndHangup(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${esc(text)}</Say><Hangup/></Response>`
}

export function dialTwiml(number: string, intro: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${esc(intro)}</Say><Dial timeout="25">${esc(number)}</Dial></Response>`
}

export const hangupTwiml = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'
