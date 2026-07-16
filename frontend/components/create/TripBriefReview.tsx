'use client'

import { useEffect, useState } from 'react'
import { MOCK_AUTH_ENABLED } from '@/lib/auth/mock-auth'
import type { UserPreferenceFact } from '@/lib/trip/backend-types'
import { getProfile } from '@/lib/trip/mock-api'
import {
  MAX_TRIP_PLACES,
  type BriefInput,
  type DraftInspirationItem,
} from '@/lib/trip/parse-inspiration'
import { buildPreferenceDisclosure } from '@/lib/trip/preference-disclosure'
import { budgetLabel } from '@/lib/trip/trip-presenters'

const SOURCE_LABEL = {
  explicit: 'Explicit',
  memory: 'Memory',
  inferred_default: 'Inferred default',
} as const

function formatFactValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return JSON.stringify(value) ?? ''
}

function humanize(value: string): string {
  return value.replaceAll('_', ' ').toLowerCase()
}

function formatMemoryFact(fact: UserPreferenceFact): string {
  const value = formatFactValue(fact.fact_value)
  if (!value) return humanize(fact.fact_key)
  if (fact.fact_key === 'likes_cuisine') return `likes ${value}`
  if (fact.fact_key === 'prefers') return `prefers ${value}`
  if (fact.fact_key === 'avoids') return `avoids ${value}`
  if (fact.category === 'budget' && fact.fact_key === 'style') {
    return `prefers ${humanize(value)} budget`
  }
  return `${humanize(fact.fact_key)}: ${value}`
}

function durationLabel(startDate: string, endDate: string): string {
  const start = Date.parse(`${startDate}T00:00:00Z`)
  const end = Date.parse(`${endDate}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Duration unavailable'
  const nights = Math.max(0, Math.round((end - start) / 86400000))
  const days = nights + 1
  return `${nights} night${nights === 1 ? '' : 's'} / ${days} day${days === 1 ? '' : 's'}`
}

function valueOrFallback(value: string, fallback: string): string {
  return value.trim() || fallback
}

export default function TripBriefReview({
  items,
  brief,
  onBack,
  onGenerate,
}: {
  items: DraftInspirationItem[]
  brief: BriefInput
  onBack: () => void
  onGenerate: () => void
}) {
  const [memoryFacts, setMemoryFacts] = useState<string[] | null>(null)

  useEffect(() => {
    if (!MOCK_AUTH_ENABLED) return
    let active = true
    getProfile()
      .then(({ facts }) => {
        if (!active) return
        setMemoryFacts(facts.filter((fact) => fact.status === 'active').map(formatMemoryFact))
      })
      .catch(() => {
        if (active) setMemoryFacts(null)
      })
    return () => { active = false }
  }, [])

  const reels = items.filter((item) => item.item_type === 'reel_url')
  const places = items.filter((item) => item.item_type === 'requested_place')
  const disclosure = buildPreferenceDisclosure(brief.preferences, memoryFacts)
  const isOverScope = reels.length + places.length > MAX_TRIP_PLACES

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="type-display text-3xl text-[var(--starlight)]">Review your trip brief</h2>
        <p className="type-body text-sm text-[var(--muted)]">
          Check the details Astrail will use before it starts building your route.
        </p>
      </div>

      <div className="surface flex flex-col gap-4 p-4">
        <div>
          <p className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)]">Reels ({reels.length})</p>
          {reels.length ? (
            <ul className="mt-2 flex flex-col gap-2">
              {reels.map((item) => (
                <li key={item.key} className="type-evidence truncate text-xs text-[var(--muted)]">
                  {item.normalized_reel_url}
                </li>
              ))}
            </ul>
          ) : (
            <p className="type-body mt-2 text-sm text-[var(--faint)]">None submitted</p>
          )}
        </div>

        <div>
          <p className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)]">Requested places ({places.length})</p>
          {places.length ? (
            <ul className="mt-2 flex flex-col gap-1">
              {places.map((item) => (
                <li key={item.key} className="type-body text-sm text-[var(--starlight)]">{item.requested_place_text}</li>
              ))}
            </ul>
          ) : (
            <p className="type-body mt-2 text-sm text-[var(--faint)]">None submitted</p>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)]">Destination hint</p>
            <p className="type-body mt-1 text-sm text-[var(--starlight)]">
              {valueOrFallback(brief.destination_hint, 'Not set — Astrail will infer')}
            </p>
          </div>
          <div>
            <p className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)]">Dates</p>
            <p className="type-body mt-1 text-sm text-[var(--starlight)]">{brief.start_date} to {brief.end_date}</p>
            <p className="type-body mt-1 text-xs text-[var(--muted)]">
              {durationLabel(brief.start_date, brief.end_date)}
            </p>
          </div>
          <div>
            <p className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)]">Budget</p>
            <p className="type-body mt-1 text-sm text-[var(--starlight)]">
              {brief.budget_level ? budgetLabel(brief.budget_level) : 'Mid-range (default)'}
            </p>
          </div>
          {brief.origin_city.trim() ? (
            <div>
              <p className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)]">Origin city</p>
              <p className="type-body mt-1 text-sm text-[var(--starlight)]">{brief.origin_city.trim()}</p>
            </div>
          ) : null}
        </div>
      </div>

      <div className="surface flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)]">Preferences</p>
          <span className="type-label rounded-[var(--radius-chip)] bg-[rgba(247,243,232,0.08)] px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--muted)]">
            {SOURCE_LABEL[disclosure.source]}
          </span>
        </div>
        <p className="type-body text-sm text-[var(--starlight)]">{disclosure.summary}</p>
        {disclosure.lines.length ? (
          <ul className="type-body list-disc pl-4 text-sm text-[var(--muted)]">
            {disclosure.lines.map((line) => <li key={line}>{line}</li>)}
          </ul>
        ) : null}
      </div>

      {isOverScope ? (
        <p role="alert" className="type-body text-sm text-[var(--warn)]">
          That&apos;s more than fits an itinerary — Astrail will prioritize and may drop some.
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <button
          type="button"
          onClick={onBack}
          className="type-label rounded-lg px-4 py-3 text-sm uppercase tracking-wide text-[var(--faint)] transition-colors hover:bg-[rgba(247,243,232,0.06)] hover:text-[var(--muted)]"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onGenerate}
          className="type-label rounded-lg border border-[var(--brass)] bg-[var(--brass-glow)] px-4 py-3 text-sm uppercase tracking-wide text-[var(--starlight)] transition-colors hover:bg-[rgba(201,151,78,0.38)]"
        >
          Generate my trip
        </button>
      </div>
    </section>
  )
}
