'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { saveProfile } from '@/lib/trip/supabase-api'
import {
  EMPTY_DRAFT, STEPS, TRAVEL_STYLE_OPTIONS, INTEREST_OPTIONS,
  toggleTag, toProfileInput, canFinish, type OnboardingDraft,
} from '@/lib/onboarding/onboarding'
import ChipMultiSelect from './ChipMultiSelect'

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="type-label text-[10px] uppercase tracking-wide text-[var(--faint)]">{label}</dt>
      <dd className="type-body text-sm text-[var(--starlight)]">{value}</dd>
    </div>
  )
}

export default function OnboardingWizard() {
  const router = useRouter()
  const [draft, setDraft] = useState<OnboardingDraft>(EMPTY_DRAFT)
  const [stepIndex, setStepIndex] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const activeRef = useRef(true)

  // Mounted-guard: saveProfile is async. Do not navigate on an unmounted component.
  useEffect(() => {
    activeRef.current = true
    return () => { activeRef.current = false }
  }, [])

  const step = STEPS[stepIndex]
  const isLast = stepIndex === STEPS.length - 1
  const set = <K extends keyof OnboardingDraft>(key: K, value: OnboardingDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  async function finish() {
    setSaving(true)
    setSaveError(null)
    try {
      await saveProfile(toProfileInput(draft))
    } catch (err) {
      if (activeRef.current) {
        setSaving(false)
        setSaveError(err instanceof Error ? err.message : 'Could not save your preferences.')
      }
      return
    }
    if (!activeRef.current) return
    router.push('/app')
  }

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-lg flex-col gap-8 bg-[var(--void)] p-6">
      <div className="flex flex-col gap-2">
        <span className="type-label text-[10px] uppercase tracking-wide text-[var(--faint)]">
          Step {stepIndex + 1} of {STEPS.length}
        </span>
        <div
          className="flex gap-1"
          role="progressbar"
          aria-valuenow={stepIndex + 1}
          aria-valuemin={1}
          aria-valuemax={STEPS.length}
        >
          {STEPS.map((s, i) => (
            <span
              key={s.key}
              className={['h-1 flex-1 rounded-full', i <= stepIndex ? 'bg-[var(--brass)]' : 'bg-[var(--line)]'].join(' ')}
            />
          ))}
        </div>
        <h1 className="type-display text-3xl text-[var(--starlight)]">{step.title}</h1>
      </div>

      <section className="flex flex-col gap-4">
        {step.key === 'origin' ? (
          <div className="flex flex-col gap-2">
            <label htmlFor="origin-city" className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)]">
              Origin city
            </label>
            <input
              id="origin-city"
              value={draft.origin_city}
              onChange={(e) => set('origin_city', e.target.value)}
              placeholder="e.g. Kuala Lumpur"
              className="surface type-body rounded-lg p-2.5 text-sm text-[var(--starlight)] placeholder:text-[var(--faint)]"
            />
          </div>
        ) : null}

        {step.key === 'style' ? (
          <ChipMultiSelect
            ariaLabel="Travel style"
            options={TRAVEL_STYLE_OPTIONS}
            selected={draft.travel_style_tags}
            onToggle={(t) => set('travel_style_tags', toggleTag(draft.travel_style_tags, t))}
          />
        ) : null}

        {step.key === 'interests' ? (
          <ChipMultiSelect
            ariaLabel="Interests"
            options={INTEREST_OPTIONS}
            selected={draft.preference_tags}
            onToggle={(t) => set('preference_tags', toggleTag(draft.preference_tags, t))}
          />
        ) : null}

        {step.key === 'notes' ? (
          <div className="flex flex-col gap-2">
            <label htmlFor="notes" className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)]">
              Anything Astrail should remember?
            </label>
            <textarea
              id="notes"
              rows={4}
              value={draft.preference_notes}
              onChange={(e) => set('preference_notes', e.target.value)}
              placeholder="Budget style, pace, things you avoid…"
              className="surface type-body rounded-lg p-3 text-sm text-[var(--starlight)] placeholder:text-[var(--faint)]"
            />
          </div>
        ) : null}

        {step.key === 'review' ? (
          <dl className="surface flex flex-col gap-3 rounded-xl p-4">
            <ReviewRow label="Origin" value={draft.origin_city || 'Not set'} />
            <ReviewRow label="Style" value={draft.travel_style_tags.join(', ') || 'None yet'} />
            <ReviewRow label="Interests" value={draft.preference_tags.join(', ') || 'None yet'} />
            <ReviewRow label="Notes" value={draft.preference_notes || 'None'} />
          </dl>
        ) : null}
      </section>

      {saveError ? (
        <p className="type-body text-xs text-red-400" role="alert">{saveError}</p>
      ) : null}

      <div className="mt-auto flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
          disabled={stepIndex === 0}
          className="type-label rounded-lg border border-[var(--line)] px-4 py-2 text-xs uppercase tracking-wide text-[var(--muted)] disabled:opacity-30"
        >
          Back
        </button>

        {isLast ? (
          <button
            type="button"
            onClick={finish}
            disabled={!canFinish(draft) || saving}
            className="type-label rounded-lg border border-[var(--brass)] bg-[var(--brass-soft)] px-4 py-2 text-xs uppercase tracking-wide text-[var(--starlight)] disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Finish'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setStepIndex((i) => Math.min(STEPS.length - 1, i + 1))}
            className="type-label rounded-lg border border-[var(--brass)] bg-[var(--brass-soft)] px-4 py-2 text-xs uppercase tracking-wide text-[var(--starlight)]"
          >
            Next
          </button>
        )}
      </div>
    </main>
  )
}
