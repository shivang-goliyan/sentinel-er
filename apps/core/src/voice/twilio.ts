import twilio from 'twilio'

export interface Telephony {
  createCall(opts: { to: string; from: string; twiml: string; statusCallback: string }): Promise<{ sid: string }>
  hangup(callSid: string): Promise<void>
  // true when the webhook really came from Twilio
  validate(signature: string | undefined, url: string, params: Record<string, string>, query: Record<string, string>): boolean
  voiceToken(identity: string): string
  fetchRecording(recordingSid: string): Promise<Response>
}

export interface TwilioEnv {
  TWILIO_ACCOUNT_SID?: string
  TWILIO_AUTH_TOKEN?: string
  TWILIO_API_KEY_SID?: string
  TWILIO_API_KEY_SECRET?: string
  TWILIO_TWIML_APP_SID?: string
  VOICE_WEBHOOK_SECRET?: string
}

export function twilioTelephony(env: TwilioEnv = process.env): Telephony | null {
  const { TWILIO_ACCOUNT_SID: account, TWILIO_API_KEY_SID: keySid, TWILIO_API_KEY_SECRET: keySecret } = env
  if (!account || !keySid || !keySecret) return null
  const client = twilio(keySid, keySecret, { accountSid: account })

  return {
    async createCall({ to, from, twiml, statusCallback }) {
      const call = await client.calls.create({
        to,
        from,
        twiml,
        statusCallback,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        // a drill call never needs more than a few minutes; this stops a stuck one burning credit
        timeLimit: 600,
        timeout: 30,
      })
      return { sid: call.sid }
    },

    async hangup(callSid) {
      await client.calls(callSid).update({ status: 'completed' })
    },

    validate(signature, url, params, query) {
      if (env.TWILIO_AUTH_TOKEN) {
        return Boolean(signature) && twilio.validateRequest(env.TWILIO_AUTH_TOKEN, signature!, url, params)
      }
      // without the auth token we fall back to a secret in the webhook URL
      return Boolean(env.VOICE_WEBHOOK_SECRET) && query.k === env.VOICE_WEBHOOK_SECRET
    },

    voiceToken(identity) {
      const { AccessToken } = twilio.jwt
      const token = new AccessToken(account, keySid, keySecret, { identity, ttl: 3600 })
      token.addGrant(
        new AccessToken.VoiceGrant({ incomingAllow: true, outgoingApplicationSid: env.TWILIO_TWIML_APP_SID }),
      )
      return token.toJwt()
    },

    fetchRecording(recordingSid) {
      const auth = Buffer.from(`${keySid}:${keySecret}`).toString('base64')
      return fetch(`https://api.twilio.com/2010-04-01/Accounts/${account}/Recordings/${recordingSid}.mp3`, {
        headers: { authorization: `Basic ${auth}` },
      })
    },
  }
}
