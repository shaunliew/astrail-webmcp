'use client'

export default function ChipMultiSelect({
  options, selected, onToggle, ariaLabel,
}: {
  options: readonly string[]
  selected: string[]
  onToggle: (value: string) => void
  ariaLabel: string
}) {
  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-2">
      {options.map((opt) => {
        const on = selected.includes(opt)
        return (
          <button
            key={opt}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(opt)}
            className={[
              'type-label rounded-[6px] px-3 py-1.5 text-xs uppercase tracking-wide transition-colors',
              on
                ? 'border border-[rgba(201,151,78,0.35)] bg-[var(--brass-soft)] text-[var(--brass-bright)]'
                : 'bg-[var(--chip-bg)] text-[var(--muted)] hover:text-[var(--starlight)]',
            ].join(' ')}
          >
            {opt}
          </button>
        )
      })}
    </div>
  )
}
