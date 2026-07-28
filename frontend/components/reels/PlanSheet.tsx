'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { getProfile } from '@/lib/trip/supabase-api'
import { budgetLabel } from '@/lib/trip/trip-presenters'
import type { BriefInput } from '@/lib/trip/parse-inspiration'
import type { SavedReelPlaceProof } from '@/lib/reels/backend-types'
import type { BudgetLevel } from '@/lib/trip/backend-types'
import VerifiedPlacesMap from './VerifiedPlacesMap'

/* The slim plan sheet (02-tray state B): Astrail already knows almost everything, so it
   shows the inferred values with their provenance and asks only for dates. Replaces the
   old 6-field brief form + review. Map-first, over the selected places. Inferred values
   come from the places (Where) and the saved profile (From / Style); Budget defaults. */

function deriveDestination(places: SavedReelPlaceProof[]): string {
  const countries = Array.from(new Set(places.map((p) => p.country_name).filter(Boolean)))
  if (countries.length === 0) return ''
  if (countries.length === 1) return countries[0]
  if (countries.length === 2) return `${countries[0]} & ${countries[1]}`
  return `${countries.length} countries`
}

const BUDGETS: BudgetLevel[] = ['budget', 'mid_range', 'premium', 'luxury']
const INPUT =
  'min-h-11 rounded-lg border border-[color:var(--line-soft)] bg-[color:var(--surface-1)] px-3 text-[color:var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[color:var(--line-soft)] py-3">
      <span className="pt-0.5 text-[13px] text-[color:var(--text-muted)]">{label}</span>
      <span className="flex min-w-0 flex-col items-end text-right">{children}</span>
    </div>
  )
}
function Provenance({ children }: { children: React.ReactNode }) {
  return <span className="mt-0.5 text-[11px] uppercase tracking-wide text-[color:var(--text-faint)]">{children}</span>
}

export default function PlanSheet({
  places,
  reelCount,
  brief,
  onBrief,
  onBack,
  onGenerate,
  error,
}: {
  places: SavedReelPlaceProof[]
  reelCount: number
  brief: BriefInput
  onBrief: (updater: (b: BriefInput) => BriefInput) => void
  onBack: () => void
  onGenerate: () => void
  error?: string | null
}) {
  const [originFromProfile, setOriginFromProfile] = useState<string | null>(null)
  const [styleFromProfile, setStyleFromProfile] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const populated = useRef(false)
  const destination = useMemo(() => deriveDestination(places), [places])

  // Pre-fill the brief once from the selected places + saved profile (never clobber edits).
  useEffect(() => {
    if (populated.current) return
    populated.current = true
    if (destination) onBrief((b) => (b.destination_hint ? b : { ...b, destination_hint: destination }))
    let active = true
    getProfile()
      .then(({ profile }) => {
        if (!active) return
        const origin = profile.origin_city ?? null
        const style = [...(profile.travel_style_tags ?? []), profile.preference_notes ?? ''].filter(Boolean).join(', ') || null
        setOriginFromProfile(origin)
        setStyleFromProfile(style)
        onBrief((b) => ({
          ...b,
          origin_city: b.origin_city || (origin ?? ''),
          preferences: b.preferences || (style ?? ''),
        }))
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [destination, onBrief])

  const ready = Boolean(brief.start_date && brief.end_date)
  const whereText = brief.destination_hint || destination
  const originText = brief.origin_city || originFromProfile || ''
  const styleText = brief.preferences || styleFromProfile || ''

  return (
    <div className="fixed inset-0 z-50 overflow-hidden bg-[color:var(--night-900)]">
      <VerifiedPlacesMap places={places} className="absolute inset-0 h-full w-full" />

      <div className="absolute left-0 top-0 z-10 p-4">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to places"
          className="flex h-11 w-11 items-center justify-center rounded-full border border-[rgba(232,182,103,0.3)] bg-[rgba(18,22,31,0.82)] text-[18px] text-[color:var(--starlight)] transition-colors hover:bg-[color:var(--night-700)]"
        >
          ←
        </button>
      </div>

      <section className="absolute z-20 flex flex-col border border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)] text-[color:var(--text)] shadow-[0_1px_2px_rgba(28,23,16,0.10),0_-10px_44px_rgba(0,0,0,0.4)] inset-x-0 bottom-0 max-h-[82dvh] rounded-t-2xl md:inset-x-auto md:left-4 md:top-4 md:bottom-4 md:w-[420px] md:max-h-none md:rounded-2xl">
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-24 pt-6">
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="font-display text-[22px] font-medium leading-[1.22] tracking-[-0.015em]" style={{ fontVariationSettings: "'SOFT' 28, 'WONK' 1, 'opsz' 22" }}>
              Plan this trip
            </h2>
            <span className="text-[13px] text-[color:var(--text-faint)]">{places.length} places</span>
          </div>

          <div>
            <Row label="Where">
              {editing ? (
                <input
                  aria-label="Destination"
                  value={brief.destination_hint}
                  onChange={(e) => onBrief((b) => ({ ...b, destination_hint: e.target.value }))}
                  placeholder={destination || 'Where to?'}
                  className={`w-44 text-right ${INPUT}`}
                />
              ) : (
                <>
                  <span className="text-[15px] font-medium">{whereText || 'Astrail will infer'}</span>
                  <Provenance>From {reelCount} of your Reels</Provenance>
                </>
              )}
            </Row>

            <Row label="From">
              {editing ? (
                <input
                  aria-label="Origin city"
                  value={brief.origin_city}
                  onChange={(e) => onBrief((b) => ({ ...b, origin_city: e.target.value }))}
                  placeholder="Home city"
                  className={`w-44 text-right ${INPUT}`}
                />
              ) : (
                <>
                  <span className="text-[15px] font-medium">{originText || 'Not set'}</span>
                  <Provenance>{originText ? 'Your profile' : 'Optional'}</Provenance>
                </>
              )}
            </Row>

            <Row label="Budget">
              {editing ? (
                <select
                  aria-label="Budget"
                  value={brief.budget_level}
                  onChange={(e) => onBrief((b) => ({ ...b, budget_level: e.target.value as BudgetLevel | '' }))}
                  className={`w-44 text-right ${INPUT}`}
                >
                  <option value="">No preference</option>
                  {BUDGETS.map((b) => (
                    <option key={b} value={b}>{budgetLabel(b)}</option>
                  ))}
                </select>
              ) : (
                <>
                  <span className="text-[15px] font-medium">{brief.budget_level ? budgetLabel(brief.budget_level) : 'Mid-range'}</span>
                  <Provenance>{brief.budget_level ? 'Your choice' : 'Astrail’s default'}</Provenance>
                </>
              )}
            </Row>

            <Row label="Style">
              {editing ? (
                <input
                  aria-label="Style"
                  value={brief.preferences}
                  onChange={(e) => onBrief((b) => ({ ...b, preferences: e.target.value }))}
                  placeholder="Pace, food, what you avoid…"
                  className={`w-44 text-right ${INPUT}`}
                />
              ) : (
                <>
                  <span className="max-w-[220px] text-[15px] font-medium">{styleText || 'Balanced first draft'}</span>
                  <Provenance>{styleText ? 'Your profile' : 'Inferred from your Reels'}</Provenance>
                </>
              )}
            </Row>
          </div>

          <div className="mt-6">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[color:var(--text-muted)]">When are you going?</p>
            <div className="flex gap-3">
              <input type="date" aria-label="Start date" value={brief.start_date} onChange={(e) => onBrief((b) => ({ ...b, start_date: e.target.value }))} className={`flex-1 ${INPUT}`} />
              <input type="date" aria-label="End date" value={brief.end_date} onChange={(e) => onBrief((b) => ({ ...b, end_date: e.target.value }))} className={`flex-1 ${INPUT}`} />
            </div>
            <p className="mt-2 text-[13px] text-[color:var(--text-muted)]">Skip this and Astrail builds a 3-day draft you can date later.</p>
          </div>

          <button type="button" onClick={() => setEditing((e) => !e)} className="mt-4 text-[13px] font-medium text-[color:var(--brass-deep)] underline underline-offset-2">
            {editing ? 'Done editing' : 'Change any of the above'}
          </button>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-2 p-4">
          {error ? (
            <p role="alert" className="pointer-events-auto max-h-24 overflow-y-auto rounded-lg border border-dashed border-[color:var(--fail)] bg-[color:var(--surface-1)] px-3 py-2 text-[12px] text-[color:var(--fail)]">
              {error}
            </p>
          ) : null}
          <button
            type="button"
            onClick={onGenerate}
            disabled={!ready}
            className="pointer-events-auto flex min-h-[52px] w-full items-center justify-center rounded-full border border-[color:var(--accent)] bg-[color:var(--accent)] px-5 text-[14px] font-medium text-[color:var(--accent-text)] shadow-[0_10px_28px_-8px_rgba(138,90,24,0.55)] transition-opacity hover:opacity-90 disabled:cursor-default disabled:border-dashed disabled:border-[color:var(--line-soft)] disabled:bg-transparent disabled:text-[color:var(--text-muted)]"
          >
            {ready ? 'Generate trip' : 'Add your dates to generate'}
          </button>
        </div>
      </section>
    </div>
  )
}
