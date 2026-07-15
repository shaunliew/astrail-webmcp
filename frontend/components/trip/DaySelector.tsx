'use client'

import type { TripDay } from '@/lib/trip/backend-types'

function shortDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(`${iso}T00:00:00`)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export default function DaySelector({
  days, activeDayNumber, onSelect,
}: {
  days: TripDay[]
  activeDayNumber: number
  onSelect: (dayNumber: number) => void
}) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Trip days">
      {days.map((day) => {
        const active = day.day_number === activeDayNumber
        return (
          <button
            key={day.id}
            type="button"
            role="tab"
            aria-pressed={active}
            onClick={() => onSelect(day.day_number)}
            className={[
              'type-label shrink-0 rounded-lg border px-3 py-2 text-left transition-colors',
              active
                ? 'border-[rgba(201,151,78,0.35)] bg-[var(--brass-soft)] text-[var(--brass-bright)] shadow-[0_0_14px_var(--brass-glow)]'
                : 'border-transparent bg-[rgba(247,243,232,0.04)] text-[var(--muted)] hover:text-[var(--starlight)]',
            ].join(' ')}
          >
            <span className="block text-[11px] uppercase tracking-wide">Day {day.day_number}</span>
            <span className="block text-[10px] text-[var(--faint)]">{shortDate(day.day_date)}</span>
          </button>
        )
      })}
    </div>
  )
}
