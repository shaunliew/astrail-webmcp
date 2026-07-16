import type { TradeoffOption, TripTradeoffs } from '@/lib/trip/backend-types'

function humanizeAxis(axis: string): string {
  const words = axis.replaceAll('_', ' ').trim()
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : 'Tradeoff'
}

function OptionCard({ option }: { option: TradeoffOption }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--line)] p-2.5">
      <div className="flex items-start justify-between gap-2">
        <span className="type-body text-sm text-[var(--starlight)]">{option.label}</span>
        <span className="type-evidence shrink-0 text-[10px] text-[var(--faint)]">{option.value}</span>
      </div>
      <p className="type-body mt-2 text-xs text-[var(--muted)]">
        <span className="text-[var(--starlight)]">Upside:</span> {option.pro}
      </p>
      <p className="type-body mt-1 text-xs text-[var(--muted)]">
        <span className="text-[var(--starlight)]">Tradeoff:</span> {option.con}
      </p>
    </div>
  )
}

export default function TradeoffPanel({
  tradeoffs,
}: {
  tradeoffs: TripTradeoffs | null | undefined
}) {
  const notes = tradeoffs?.notes ?? []
  const comparisons = tradeoffs?.comparisons ?? []
  if (notes.length === 0 && comparisons.length === 0) {
    return null
  }

  return (
    <section className="mt-4" data-testid="tradeoff-panel">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="type-label text-[11px] uppercase tracking-wide text-[var(--faint)]">Tradeoffs</h3>
      </div>

      {notes.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {notes.map((note, index) => (
            <li key={`${note.kind}-${index}`} className="flex items-start gap-2">
              <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--warn)]" />
              <p className="type-body text-sm text-[var(--muted)]">{note.detail}</p>
            </li>
          ))}
        </ul>
      ) : null}

      {comparisons.length > 0 ? (
        <div className={notes.length > 0 ? 'mt-3 flex flex-col gap-2' : 'flex flex-col gap-2'}>
          {comparisons.map((comparison, index) => (
            <article key={`${comparison.axis}-${index}`} className="surface rounded-[var(--radius-card)] p-3" data-testid="tradeoff-comparison">
              <div className="flex items-center justify-between gap-2">
                <h4 className="type-body text-sm text-[var(--starlight)]">{humanizeAxis(comparison.axis)}</h4>
                <span className="type-evidence rounded-[var(--radius-chip)] bg-[var(--chip-bg)] px-2 py-0.5 text-[10px] tracking-wide text-[var(--muted)]">
                  Astrail
                </span>
              </div>
              <div className="mt-2 grid gap-2">
                <OptionCard option={comparison.option_a} />
                <OptionCard option={comparison.option_b} />
              </div>
              {comparison.recommendation ? (
                <p className="type-body mt-2 text-xs text-[var(--muted)]">
                  <span className="text-[var(--starlight)]">Astrail&apos;s read:</span> {comparison.recommendation}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
    </section>
  )
}
