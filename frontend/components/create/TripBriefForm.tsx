'use client'

import type { BudgetLevel } from '@/lib/trip/backend-types'
import type { BriefInput } from '@/lib/trip/parse-inspiration'
import DateRangePicker from './DateRangePicker'

const BUDGET_OPTIONS: { value: BudgetLevel; label: string }[] = [
  { value: 'budget', label: 'Budget' },
  { value: 'mid_range', label: 'Mid-range' },
  { value: 'premium', label: 'Premium' },
  { value: 'luxury', label: 'Luxury' },
]

const fieldClass =
  'surface type-body rounded-lg p-2.5 text-sm text-[var(--starlight)] placeholder:text-[var(--faint)]'
const labelClass = 'type-label text-[11px] uppercase tracking-wide text-[var(--muted)]'

export default function TripBriefForm({
  brief, onChange,
}: {
  brief: BriefInput
  onChange: (brief: BriefInput) => void
}) {
  const set = <K extends keyof BriefInput>(key: K, value: BriefInput[K]) => onChange({ ...brief, [key]: value })

  return (
    <section className="flex flex-col gap-4">
      <h2 className="type-display text-lg text-[var(--starlight)]">Trip brief</h2>
      <p className="type-body text-xs text-[var(--faint)]">Everything here is optional — Astrail fills the gaps.</p>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="destination" className={labelClass}>Destination hint</label>
        <input id="destination" className={fieldClass} placeholder="e.g. Tokyo"
          value={brief.destination_hint} onChange={(e) => set('destination_hint', e.target.value)} />
      </div>

      <DateRangePicker
        startDate={brief.start_date}
        endDate={brief.end_date}
        onChange={(start, end) => onChange({ ...brief, start_date: start, end_date: end })}
      />

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="origin" className={labelClass}>Origin city</label>
          <input id="origin" className={fieldClass} placeholder="e.g. Singapore"
            value={brief.origin_city} onChange={(e) => set('origin_city', e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="budget" className={labelClass}>Budget</label>
          <select id="budget" className={fieldClass}
            value={brief.budget_level} onChange={(e) => set('budget_level', e.target.value as BudgetLevel | '')}>
            <option value="">No preference</option>
            {BUDGET_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="preferences" className={labelClass}>Preferences</label>
        <textarea id="preferences" rows={3} className={fieldClass}
          placeholder="ramen, walkable days, slow mornings…"
          value={brief.preferences} onChange={(e) => set('preferences', e.target.value)} />
        {brief.preferences.trim().length === 0 ? (
          <p className="type-body text-xs text-[var(--faint)]">
            Preferences not provided. Astrail will infer your trip style from the Reels and build a balanced first draft.
          </p>
        ) : null}
      </div>
    </section>
  )
}
