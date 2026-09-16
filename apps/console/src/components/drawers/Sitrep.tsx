import { Fragment, useMemo, type ReactNode } from 'react'
import { utcTime } from '../../lib/format'
import { useActiveRun } from '../../lib/hooks'
import { parseMarkdown, type Span } from '../../lib/markdown'
import { runArtifacts, sitrepChecks, type CheckFinding, type SitrepCheck } from '../../store/views'
import { useConsole } from '../../store/stream'
import { EmptyState, Tag } from '../ui'

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((s, i) =>
        s.bold ? (
          <strong key={i} className="font-semibold">
            {s.text}
          </strong>
        ) : (
          <Fragment key={i}>{s.text}</Fragment>
        ),
      )}
    </>
  )
}

// React escapes every string here; the parser only ever hands back plain text
export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return (
    <div className="text-[14px] leading-relaxed text-ink-800">
      {blocks.map((b, i) => {
        if (b.type === 'heading') {
          const size = b.level === 1 ? 'text-[20px]' : b.level === 2 ? 'text-[16px]' : 'text-[14px]'
          return (
            <h4
              key={i}
              className={`mt-4 border-b border-ink-950/15 pb-0.5 font-label font-bold uppercase tracking-[0.1em] text-ink-950 first:mt-0 ${size}`}
            >
              <Spans spans={b.spans} />
            </h4>
          )
        }
        if (b.type === 'list') {
          return (
            <ul key={i} className="mt-1.5 space-y-0.5">
              {b.items.map((item, j) => (
                <li key={j} className="relative pl-4">
                  <span className="absolute left-0.5 top-[0.62em] size-[5px] bg-ink-950/55" aria-hidden />
                  <Spans spans={item} />
                </li>
              ))}
            </ul>
          )
        }
        return (
          <p key={i} className={i === 0 ? 'font-label text-[15px] font-semibold uppercase tracking-[0.12em] text-ink-950' : 'mt-1.5'}>
            <Spans spans={b.spans} />
          </p>
        )
      })}
    </div>
  )
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-line px-5 py-4">
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h3 className="panel-head">{title}</h3>
        {aside ? <div className="text-[12px] text-faint">{aside}</div> : null}
      </div>
      {children}
    </section>
  )
}

function Wrote({ f }: { f: CheckFinding }) {
  if (f.kind === 'unknown_fact') {
    return (
      <p className="text-[14px] text-paper-dim">
        cited <span className="num text-bad">{f.wrote}</span>, which is not a fact in this run
      </p>
    )
  }
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        <span className="flex items-baseline gap-2">
          <span className="font-label text-[12px] font-semibold uppercase tracking-[0.12em] text-muted">wrote</span>
          <span className="num text-[28px] leading-none text-bad line-through decoration-2">{f.wrote}</span>
        </span>
        <span className="flex items-baseline gap-2">
          <span className="font-label text-[12px] font-semibold uppercase tracking-[0.12em] text-muted">source says</span>
          {f.expected ? (
            <span className="num text-[28px] leading-none text-good">{f.expected}</span>
          ) : (
            <span className="text-[14px] text-muted">no matching figure</span>
          )}
        </span>
        {f.injected ? <Tag tone="warn">injected on purpose for the demo</Tag> : null}
      </div>
      {f.line ? (
        <p className="mt-1.5 truncate border-l-2 border-line-strong pl-2 font-mono text-[12px] text-muted" title={f.line}>
          {f.line}
        </p>
      ) : null}
      <p className="mt-1 text-[13px] text-paper-dim">
        {f.about ? <span>{f.about}</span> : null}
        {f.about && f.sourceName ? <span className="text-faint"> · </span> : null}
        {f.sourceName ? (
          f.sourceUrl ? (
            <a href={f.sourceUrl} target="_blank" rel="noreferrer" className="text-info hover:underline">
              {f.sourceName} ↗
            </a>
          ) : (
            <span className="text-info">{f.sourceName}</span>
          )
        ) : null}
      </p>
    </div>
  )
}

const SHOWN = 4

function Check({ c }: { c: SitrepCheck }) {
  const blocked = c.verdict === 'block'
  const name = c.template ? 'Template' : c.attempt !== null ? `Draft ${c.attempt}` : 'Sitrep'
  const headline = c.findings.find((f) => f.injected) ?? c.findings[0]
  const shown = c.findings.slice(0, SHOWN)
  return (
    <li
      className={`rounded-[3px] border bg-ink-900 ${blocked ? 'border-bad/45 shadow-[inset_3px_0_0_var(--color-bad)]' : 'border-good/35 shadow-[inset_3px_0_0_var(--color-good)]'}`}
    >
      <div className="flex items-center gap-2 px-4 pt-3">
        <span className="font-label text-[17px] font-bold uppercase tracking-[0.08em] text-paper">{name}</span>
        <Tag tone={blocked ? 'bad' : 'good'}>{blocked ? 'blocked' : 'passed'}</Tag>
        <span className="num ml-auto text-[12px] text-faint">{utcTime(c.ts)} UTC</span>
      </div>
      {blocked ? (
        <div className="px-4 pb-3">
          {headline ? (
            <p className="mt-1 text-[15px] text-paper">
              {name} blocked — wrote <span className="num text-bad">{headline.wrote}</span>
              {headline.expected ? (
                <>
                  {' '}
                  · source says <span className="num text-good">{headline.expected}</span>
                </>
              ) : null}
              {headline.sourceName ? <span className="text-muted"> · {headline.sourceName}</span> : null}
            </p>
          ) : null}
          {c.injected && !c.findings.some((f) => f.injected) ? (
            <p className="mt-1.5 text-[13px] text-warn">Injected on purpose for the demo: {c.injected}</p>
          ) : null}
          <ul className="mt-3 space-y-3">
            {shown.map((f, i) => (
              <li key={i} className="border-t border-line/70 pt-3 first:border-t-0 first:pt-0">
                <Wrote f={f} />
              </li>
            ))}
          </ul>
          {c.findings.length > SHOWN ? (
            <p className="mt-2 text-[12px] text-muted">and {c.findings.length - SHOWN} more in the log</p>
          ) : null}
        </div>
      ) : (
        <p className="px-4 pb-3 pt-1 text-[14px] text-paper-dim">
          {c.template
            ? 'The fixed template was used. It carries figures only as fact citations, so nothing unchecked can get in.'
            : 'Every figure cites a verified fact. Released.'}
        </p>
      )}
    </li>
  )
}

export function SitrepBody() {
  const run = useActiveRun()
  const runId = run?.id ?? null
  const sitrep = useConsole((s) => (runId ? s.view.sitreps[runId] : undefined))
  const verify = useConsole((s) => s.view.verify)
  const faults = useConsole((s) => s.view.faults)
  const facts = useConsole((s) => s.view.facts)
  const artifacts = useConsole((s) => s.view.artifacts)
  const checks = useMemo(() => sitrepChecks({ verify, faults, facts }, runId), [verify, faults, facts, runId])
  const files = useMemo(() => runArtifacts(artifacts, runId), [artifacts, runId])
  const pdf = files.find((a) => a.type === 'sitrep_pdf')
  const plan = files.find((a) => a.type === 'drone_plan')
  const blocked = checks.filter((c) => c.verdict === 'block').length

  if (!run) return <EmptyState title="No active run">The situation report is written for the incident in progress.</EmptyState>

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-ink-900/60 px-5 py-3">
        {sitrep?.final ? <Tag tone="good">verified</Tag> : <Tag tone="quiet">not written yet</Tag>}
        {sitrep?.final?.template ? <Tag tone="warn">template</Tag> : null}
        {run.mode === 'drill' ? <Tag tone="warn">drill</Tag> : null}
        <span className="ml-auto flex items-center gap-2">
          {pdf ? (
            <a
              href={pdf.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center gap-2 rounded-[3px] border border-drill bg-drill px-3 font-label text-[14px] font-semibold uppercase tracking-[0.08em] text-drill-ink hover:brightness-110"
            >
              Sitrep PDF ↓
            </a>
          ) : null}
          {plan ? (
            <a
              href={plan.url}
              download
              className="inline-flex h-8 items-center gap-2 rounded-[3px] border border-line-strong px-3 font-label text-[14px] font-semibold uppercase tracking-[0.08em] text-paper-dim hover:border-paper-dim hover:text-paper"
              title="QGroundControl mission file for the survey flights"
            >
              Drone plan ↓
            </a>
          ) : null}
        </span>
      </div>

      <Section
        title="Verifier"
        aside={checks.length ? `${checks.length} check${checks.length === 1 ? '' : 's'}${blocked ? ` · ${blocked} blocked` : ''}` : null}
      >
        {checks.length === 0 ? (
          <p className="text-[13px] text-muted">
            No checks for this run yet. Every draft is checked before release: a figure has to cite a verified fact, or the draft goes back.
          </p>
        ) : (
          <ol className="space-y-2">
            {checks.map((c, i) => (
              <Fragment key={c.seq}>
                {i > 0 && checks[i - 1]!.verdict === 'block' ? (
                  <li className="flex items-center gap-2 pl-4 text-[12px] text-muted" aria-hidden>
                    <span className="h-4 w-px bg-line-strong" />
                    sent back to the Analyst with the finding
                  </li>
                ) : null}
                <Check c={c} />
              </Fragment>
            ))}
          </ol>
        )}
      </Section>

      <Section title="Report" aside={sitrep?.final ? `${utcTime(sitrep.final.ts)} UTC` : null}>
        {sitrep?.final ? (
          <article className="rounded-[2px] bg-paper px-5 py-4 shadow-[0_1px_0_rgb(255_255_255/0.08),0_8px_24px_rgb(0_0_0/0.35)]">
            <Markdown text={sitrep.final.text} />
          </article>
        ) : (
          <p className="text-[13px] text-muted">
            Not written yet. The Analyst drafts it from verified facts once the models finish, and the Verifier checks every number before it's released.
          </p>
        )}
      </Section>

      {sitrep?.drafts.length ? (
        <Section title={`Drafts (${sitrep.drafts.length})`}>
          {sitrep.drafts.map((d) => (
            <details key={d.seq} className="mb-2">
              <summary className="cursor-pointer text-[13px] text-paper-dim">
                Draft {d.attempt} · <span className="num">{utcTime(d.ts)}</span>
              </summary>
              <pre className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap font-sans text-[13px] text-muted">{d.text}</pre>
            </details>
          ))}
        </Section>
      ) : null}
    </>
  )
}
