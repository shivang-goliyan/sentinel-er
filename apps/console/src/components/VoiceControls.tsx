import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { callPublicLine, hangUp, startPhone, stopPhone, usePhone, answer } from '../lib/softphone'
import { startListening, stopListening, useListen } from '../lib/listen'
import { operatorPost } from '../store/stream'
import { Btn, Dot } from './ui'

type VoiceState = {
  configured: boolean
  number: string | null
  busy: boolean
  record: boolean
  listen: boolean
}

const ROLES = [
  ['charge_nurse', 'Charge nurse stand-in'],
  ['lifeline_county', 'County health stand-in'],
  ['lifeline_dme', 'Equipment supplier stand-in'],
  ['switchboard', 'Switchboard stand-in'],
  ['handoff', 'Person for red-flag handoffs'],
  ['test', 'Test phone'],
] as const

const field =
  'h-8 min-w-0 rounded-[3px] border border-line-strong bg-ink-950 px-2.5 text-[13px] text-paper outline-none placeholder:text-faint focus:border-drill'

function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-line px-5 py-4">
      <h3 className="mb-2 font-label text-[13px] font-semibold uppercase tracking-[0.14em] text-muted">{title}</h3>
      {children}
    </section>
  )
}

const phoneText: Record<string, string> = {
  off: 'Softphone off',
  starting: 'Connecting…',
  ready: 'Ready for calls',
  ringing: 'Incoming call',
  'in-call': 'On a call',
  error: 'Softphone problem',
}

export function PhoneBar() {
  const { status } = usePhone()
  if (status !== 'ringing' && status !== 'in-call') return null
  return (
    <div className="flex items-center gap-3 border-b border-drill/40 bg-drill/[0.08] px-3 py-2">
      <Dot tone={status === 'ringing' ? 'warn' : 'good'} />
      <span className="flex-1 text-[14px] text-paper">{phoneText[status]} in this tab</span>
      {status === 'ringing' ? (
        <Btn kind="primary" onClick={answer}>
          Answer
        </Btn>
      ) : null}
      <Btn kind="danger" onClick={hangUp}>
        Hang up
      </Btn>
    </div>
  )
}

export function VoiceControls() {
  const phone = usePhone()
  const listen = useListen()
  const [state, setState] = useState<VoiceState | null>(null)
  const [number, setNumber] = useState('')
  const [label, setLabel] = useState('')
  const [role, setRole] = useState<string>('charge_nurse')
  const [consent, setConsent] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [testRole, setTestRole] = useState('charge_nurse')

  useEffect(() => {
    void fetch('/api/voice/state')
      .then((r) => r.json())
      .then(setState)
      .catch(() => setState(null))
  }, [])

  const add = (ev: FormEvent) => {
    ev.preventDefault()
    void operatorPost('/api/whitelist', { number, label, role, consent }, (r) => {
      if (r?.ok) {
        setNumber('')
        setLabel('')
        setConsent(false)
        setMsg('Added. The number is stored in full only on the server; the log shows the last four digits.')
      } else if (r) setMsg(r.message)
    })
  }

  const testCall = () => {
    void operatorPost('/api/calls/test', { role: testRole }, (r) => {
      setMsg(r?.ok ? 'Test call queued. Approve it on the call panel if approvals are on.' : r ? r.message : null)
    })
  }

  return (
    <>
      <Row title="Phone line">
        {state ? (
          <p className="text-[13px] text-paper-dim">
            {state.configured ? `Twilio number ${state.number}` : 'Twilio is not configured on the server yet.'}
            {state.configured ? ` · recording ${state.record ? 'on' : 'off'} · listen-in ${state.listen ? 'on' : 'off'}` : ''}
          </p>
        ) : (
          <p className="text-[13px] text-muted">Checking the line…</p>
        )}
      </Row>

      <Row title="Softphone in this tab">
        <div className="flex flex-wrap items-center gap-2">
          <Dot tone={phone.status === 'ready' || phone.status === 'in-call' ? 'good' : phone.status === 'error' ? 'bad' : 'quiet'} />
          <span className="mr-auto text-[13px] text-paper-dim">{phone.message ?? phoneText[phone.status]}</span>
          {phone.status === 'off' || phone.status === 'error' ? (
            <Btn onClick={() => void startPhone()}>Connect</Btn>
          ) : (
            <>
              <Btn onClick={() => void callPublicLine()} disabled={phone.status !== 'ready'}>
                Call the public line
              </Btn>
              <Btn kind="danger" onClick={stopPhone}>
                Disconnect
              </Btn>
            </>
          )}
        </div>
        <p className="mt-2 text-[12px] text-muted">
          Calls to <span className="num">client:console</span> ring here. Present this tab in Meet so the room hears them.
        </p>
      </Row>

      <Row title="Listen in">
        <div className="flex items-center gap-2">
          <span className="mr-auto text-[13px] text-paper-dim">{listen.message ?? 'Plays both sides of the live call here.'}</span>
          {listen.on ? (
            <Btn kind="danger" onClick={stopListening}>
              Stop
            </Btn>
          ) : (
            <Btn onClick={startListening}>Listen</Btn>
          )}
        </div>
      </Row>

      <Row title="Add a number to the whitelist">
        <form onSubmit={add} className="grid grid-cols-2 gap-2">
          <input className={field} value={number} onChange={(e) => setNumber(e.target.value)} placeholder="+1 571 555 0100 or client:console" inputMode="tel" />
          <input className={field} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Who this is" />
          <select className={`${field} col-span-2`} value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
          <label className="col-span-2 flex items-start gap-2 text-[12px] text-paper-dim">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 accent-[var(--color-drill)]" />
            This person agreed, just now, to receive automated, recorded drill calls from Sentinel ER at this number.
          </label>
          <div className="col-span-2 flex justify-end">
            <Btn type="submit" kind="primary" disabled={!consent || !number.trim() || !label.trim()}>
              Add number
            </Btn>
          </div>
        </form>
        <p className="mt-2 text-[12px] text-muted">Real hospital numbers are refused. Only numbers on this list are ever dialled. Enter <span className="num">client:console</span> to ring this tab instead of a phone.</p>
      </Row>

      <Row title="Test call">
        <div className="flex gap-2">
          <select className={`${field} flex-1`} value={testRole} onChange={(e) => setTestRole(e.target.value)}>
            {ROLES.slice(0, 4).map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
          <Btn onClick={testCall}>Queue call</Btn>
        </div>
        {msg ? <p className="mt-2 text-[12px] text-muted">{msg}</p> : null}
      </Row>
    </>
  )
}
