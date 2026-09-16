const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

export interface RelayTwiml {
  base: string // https://host
  callRef: string
  greeting: string
  record: boolean
  listen: boolean
  webhookQuery?: string // "k=..." when signatures aren't available
}

const wss = (base: string) => base.replace(/^http/, 'ws')

export function relayTwiml(o: RelayTwiml): string {
  const q = o.webhookQuery ? `?${o.webhookQuery}` : ''
  const amp = o.webhookQuery ? `&amp;${esc(o.webhookQuery)}` : ''
  const parts = ['<?xml version="1.0" encoding="UTF-8"?><Response>']
  if (o.record) {
    parts.push(
      `<Start><Recording channels="dual" recordingStatusCallback="${esc(o.base)}/voice/recording${esc(q)}" recordingStatusCallbackEvent="completed"/></Start>`,
    )
  }
  if (o.listen) {
    parts.push(`<Start><Stream url="${esc(wss(o.base))}/voice/listen" track="both_tracks"/></Start>`)
  }
  parts.push(
    `<Connect action="${esc(o.base)}/voice/connect-action?ref=${esc(o.callRef)}${amp}">`,
    `<ConversationRelay url="${esc(wss(o.base))}/voice/relay" welcomeGreeting="${esc(o.greeting)}" welcomeGreetingInterruptible="none" language="en-US" interruptible="speech" ttsProvider="ElevenLabs" transcriptionProvider="Deepgram" dtmfDetection="true">`,
    `<Parameter name="callRef" value="${esc(o.callRef)}"/>`,
    '</ConversationRelay></Connect></Response>',
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
