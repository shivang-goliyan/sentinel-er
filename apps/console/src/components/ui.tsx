import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Fact } from '@sentinel/shared'
import type { Tone } from '../lib/format'
import { shortDate, utcTime } from '../lib/format'
import { factRef } from '../store/fold'
import { useConsole } from '../store/stream'

export function Panel({
  title,
  aside,
  children,
  className = '',
  bodyClass = '',
  delay = 0,
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
  className?: string
  bodyClass?: string
  delay?: number
}) {
  return (
    <section
      className={`panel flex min-h-0 flex-col animate-rise ${className}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      <header className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-line px-3">
        <h2 className="panel-head">{title}</h2>
        {aside ? <div className="flex items-center gap-2 text-xs text-muted">{aside}</div> : null}
      </header>
      <div className={`min-h-0 flex-1 ${bodyClass}`}>{children}</div>
    </section>
  )
}

export function EmptyState({ title, children, compact = false }: { title: string; children?: ReactNode; compact?: boolean }) {
  return (
    <div className={`flex h-full flex-col justify-center ${compact ? 'px-3 py-3' : 'px-5 py-6'}`}>
      <p className="font-label text-[15px] font-semibold uppercase tracking-[0.1em] text-paper-dim">{title}</p>
      {children ? <p className="mt-1.5 max-w-[46ch] text-[13px] leading-relaxed text-muted">{children}</p> : null}
    </div>
  )
}

const toneText: Record<Tone, string> = {
  plain: 'text-paper-dim border-line-strong',
  good: 'text-good border-good/40',
  warn: 'text-warn border-warn/45',
  bad: 'text-bad border-bad/50',
  info: 'text-info border-info/35',
  quiet: 'text-faint border-line',
}

export function Tag({ tone = 'plain', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex h-[18px] shrink-0 items-center rounded-[2px] border px-1.5 font-mono text-[10.5px] font-medium uppercase tracking-wide ${toneText[tone]}`}
    >
      {children}
    </span>
  )
}

function FactCard({ fact, rect }: { fact: Fact; rect: DOMRect }) {
  const width = 288
  const above = rect.top > 190
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8)
  const style = above
    ? { left, bottom: window.innerHeight - rect.top + 8, width }
    : { left, top: rect.bottom + 8, width }
  return createPortal(
    <div
      role="tooltip"
      style={style}
      className="pointer-events-none fixed z-50 rounded-[3px] border border-line-strong bg-ink-750 p-3 text-left shadow-[0_12px_32px_rgb(0_0_0/0.55)]"
    >
      <span className="block text-[12px] text-muted">
        <span className="num text-faint">{fact.id}</span> · {fact.label}
      </span>
      <span className="num mt-0.5 block text-[18px] text-paper">{fact.display}</span>
      <span className="mt-2 block border-t border-line pt-2 text-[12px] leading-snug text-paper-dim">
        {fact.source.name}
        <span className="block text-faint">
          {fact.source.method} · {shortDate(fact.source.retrieved_at)} {utcTime(fact.source.retrieved_at)} UTC
        </span>
        {fact.source.url ? <span className="mt-1 block truncate text-info">{fact.source.url}</span> : null}
      </span>
    </div>,
    document.body,
  )
}

// Wraps anything that stands for a fact; hovering shows where the number came from.
export function FactHover({ fact, children, className = '' }: { fact: Fact; children: ReactNode; className?: string }) {
  const [rect, setRect] = useState<DOMRect | null>(null)
  const ref = useRef<HTMLSpanElement>(null)
  return (
    <span
      ref={ref}
      className={className}
      onMouseEnter={() => setRect(ref.current?.getBoundingClientRect() ?? null)}
      onMouseLeave={() => setRect(null)}
      onFocus={() => setRect(ref.current?.getBoundingClientRect() ?? null)}
      onBlur={() => setRect(null)}
    >
      {children}
      {rect ? <FactCard fact={fact} rect={rect} /> : null}
    </span>
  )
}

export function FactChip({ id, runId }: { id: string; runId?: string | null }) {
  const fact = useConsole((s) => {
    const run = runId ?? s.view.activeRunId
    return run ? s.view.facts[factRef(run, id)] : undefined
  })
  if (!fact) {
    return (
      <span className="inline-flex h-[18px] items-center rounded-[2px] border border-bad/50 px-1 font-mono text-[10.5px] text-bad">
        {id}?
      </span>
    )
  }
  const chip = (
    <FactHover
      fact={fact}
      className="inline-flex h-[18px] cursor-help items-center rounded-[2px] border border-line-strong bg-ink-800 px-1 font-mono text-[10.5px] text-paper-dim hover:border-drill/60 hover:text-paper"
    >
      {fact.id}
    </FactHover>
  )
  return fact.source.url ? (
    <a href={fact.source.url} target="_blank" rel="noreferrer">
      {chip}
    </a>
  ) : (
    chip
  )
}

export function Dot({ tone }: { tone: Tone }) {
  const c: Record<Tone, string> = {
    plain: 'bg-paper-dim',
    good: 'bg-good',
    warn: 'bg-warn',
    bad: 'bg-bad',
    info: 'bg-info',
    quiet: 'bg-faint',
  }
  return <span className={`inline-block size-2 shrink-0 rounded-full ${c[tone]}`} />
}

export function Btn({
  children,
  onClick,
  kind = 'ghost',
  disabled,
  type = 'button',
  title,
}: {
  children: ReactNode
  onClick?: () => void
  kind?: 'ghost' | 'primary' | 'danger'
  disabled?: boolean
  type?: 'button' | 'submit'
  title?: string
}) {
  const styles = {
    ghost: 'border-line-strong text-paper-dim hover:border-paper-dim hover:text-paper',
    primary: 'border-drill bg-drill text-drill-ink hover:brightness-110',
    danger: 'border-bad/60 text-bad hover:bg-bad/10',
  }[kind]
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-[3px] border px-3 font-label text-[14px] font-semibold uppercase tracking-[0.08em] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  )
}
