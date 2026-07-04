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
              'type-label rounded-full border px-3 py-1.5 text-xs uppercase tracking-wide transition-colors',
              on
                ? 'border-[var(--brass)] bg-[var(--brass-soft)] text-[var(--starlight)]'
                : 'border-[var(--line)] text-[var(--muted)] hover:text-[var(--starlight)]',
            ].join(' ')}
          >
            {opt}
          </button>
        )
      })}
    </div>
  )
}
