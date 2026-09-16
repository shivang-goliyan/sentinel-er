import { useEffect, useRef, useState, type FormEvent } from 'react'
import { cancelUnlock, submitPasscode, useConsole } from '../store/stream'
import { Btn } from './ui'

export function OperatorDialog() {
  const open = useConsole((s) => s.unlockOpen)
  const reason = useConsole((s) => s.unlockReason)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setValue('')
      setError(null)
      setTimeout(() => input.current?.focus(), 0)
    }
  }, [open])

  if (!open) return null

  const submit = async (ev: FormEvent) => {
    ev.preventDefault()
    if (!value.trim()) return
    setChecking(true)
    setError(null)
    try {
      const res = await fetch('/api/operator/check', { method: 'POST', headers: { 'x-operator': value.trim() } })
      if (res.status === 204 || res.ok) submitPasscode(value.trim())
      else if (res.status === 429) setError('Too many wrong tries. Wait a minute before trying again.')
      else setError('That passcode is not right.')
    } catch {
      setError('Could not reach the server.')
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/75 backdrop-blur-[2px]" onMouseDown={cancelUnlock}>
      <form
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
        className="w-[380px] rounded-[4px] border border-line-strong bg-ink-850 shadow-[0_24px_60px_rgb(0_0_0/0.6)]"
        aria-labelledby="unlock-title"
        onKeyDown={(e) => e.key === 'Escape' && cancelUnlock()}
      >
        <div className="hazard h-1" />
        <div className="p-5">
          <h2 id="unlock-title" className="font-label text-[20px] font-bold uppercase tracking-[0.12em] text-paper">
            Operator
          </h2>
          <p className="mt-1 text-[13px] text-muted">{reason ?? 'Enter the operator passcode.'}</p>
          <p className="mt-1 text-[12px] text-faint">Approvals, switches and calls are operator-only. The passcode stays in this tab.</p>
          <input
            ref={input}
            type="password"
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="mt-4 h-10 w-full rounded-[3px] border border-line-strong bg-ink-950 px-3 font-mono text-[15px] text-paper outline-none focus:border-drill"
            aria-label="Operator passcode"
          />
          {error ? <p className="mt-2 text-[13px] text-bad">{error}</p> : null}
          <div className="mt-5 flex justify-end gap-2">
            <Btn onClick={cancelUnlock}>Cancel</Btn>
            <Btn kind="primary" type="submit" disabled={checking || !value.trim()}>
              {checking ? 'Checking' : 'Unlock'}
            </Btn>
          </div>
        </div>
      </form>
    </div>
  )
}
