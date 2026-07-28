'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { saveProfile } from '@/lib/trip/supabase-api'
import { EMPTY_DRAFT, toProfileInput, type OnboardingDraft } from '@/lib/onboarding/onboarding'
import { DoorBrand, DoorStage, FOCUS_RING } from '@/components/door/DoorChrome'

/* Two questions and a skip — the whole of onboarding (DESIGN.md §9). Least friction:
   origin (skippable) + pace (skippable). Both paths call saveProfile, which sets
   onboarding_completed=true, then land the user in /app. No draft trip, no interests/
   notes/review. Pace is stored as a free-form travel_style_tag (lib/onboarding note).

   Deferred (add friction/integration, tracked as follow-ups): reverse-geocoding the
   browser location to pre-fill origin, and the fly-to-origin map landing on finish. */

const PACE = [
  { tag: 'relaxed', name: 'Relaxed', what: 'Two or three stops a day, long meals, slow mornings.' },
  { tag: 'balanced', name: 'Balanced', what: 'Four or five stops, with room to sit down between them.' },
  { tag: 'packed', name: 'Packed', what: 'Six or more. You’d rather be tired than miss something.' },
] as const

// Primary (brass fill); disabled states its blocker in dashed + muted, never a grey slab.
const BTN_PRIMARY = `flex min-h-11 w-full items-center justify-center rounded-lg border border-[color:var(--accent)] bg-[color:var(--accent)] px-5 text-[14px] font-medium text-[color:var(--accent-text)] transition-opacity duration-150 hover:opacity-90 disabled:cursor-default disabled:border-dashed disabled:border-[color:var(--line-soft)] disabled:bg-transparent disabled:text-[color:var(--text-muted)] disabled:hover:opacity-100 ${FOCUS_RING}`
// Skip is visible, not hidden in a corner (DESIGN.md §9).
const BTN_GHOST = `mt-3 flex min-h-11 w-full items-center justify-center rounded-lg px-5 text-[14px] font-medium text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--surface-2)] disabled:cursor-default disabled:opacity-60 ${FOCUS_RING}`

function Dot({ done }: { done: boolean }) {
  return (
    <span
      className={`h-2.5 w-2.5 flex-none rounded-full border-[1.5px] transition-colors duration-300 ${
        done ? 'border-[color:var(--brass-deep)] bg-[color:var(--brass-deep)]' : 'border-dashed border-[color:var(--ink-400)] bg-transparent'
      }`}
    />
  )
}

function Line({ drawn }: { drawn: boolean }) {
  return (
    <span className="relative h-[1.5px] flex-1 overflow-hidden bg-[color:var(--line-soft)]">
      <span
        className={`absolute inset-y-0 left-0 bg-[color:var(--brass-deep)] transition-[width] duration-500 ${drawn ? 'w-full' : 'w-0'}`}
      />
    </span>
  )
}

export default function OnboardingWizard() {
  const router = useRouter()
  const [draft, setDraft] = useState<OnboardingDraft>(EMPTY_DRAFT)
  const [pace, setPace] = useState<string | null>(null)
  const [stepNum, setStepNum] = useState<1 | 2>(1)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const originValid = draft.origin_city.trim().length >= 2

  async function finish(withPace: string | null) {
    setSaving(true)
    setSaveError(null)
    const input = toProfileInput({ ...draft, travel_style_tags: withPace ? [withPace] : [] })
    try {
      await saveProfile(input)
    } catch (err) {
      setSaving(false)
      setSaveError(err instanceof Error ? err.message : 'Could not save your preferences.')
      return
    }
    router.push('/app')
  }

  return (
    <DoorStage caption={stepNum === 1 ? 'Nothing on your map yet.' : 'Almost there.'}>
      <DoorBrand />

      {/* Progress = the point and the line. Endowed: dot 1 (signing in) is already placed;
          the line only draws once a second point exists to draw it to (DESIGN.md §1, §9). */}
      <div
        className="mb-8 flex w-[104px] items-center"
        role="progressbar"
        aria-valuemin={1}
        aria-valuemax={3}
        aria-valuenow={stepNum + 1}
        aria-label={`Step ${stepNum} of 2`}
      >
        <Dot done />
        <Line drawn={stepNum >= 2} />
        <Dot done={stepNum >= 2} />
        <Line drawn={false} />
        <Dot done={false} />
      </div>

      {stepNum === 1 ? (
        <section>
          <h1
            className="mb-2 font-display text-[22px] font-medium leading-[1.22] tracking-[-0.015em]"
            style={{ fontVariationSettings: "'SOFT' 28, 'WONK' 1, 'opsz' 22" }}
          >
            Where do you travel from?
          </h1>
          {/* Every ask states its payoff on the same screen. One clause. */}
          <p className="mb-6 text-[14px] text-[color:var(--text-muted)]">Flight times and prices are worked out from here.</p>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (originValid) setStepNum(2)
            }}
          >
            <div className="mb-6">
              <label htmlFor="origin" className="sr-only">
                Home city
              </label>
              <input
                id="origin"
                type="text"
                autoComplete="address-level2"
                value={draft.origin_city}
                onChange={(e) => setDraft((d) => ({ ...d, origin_city: e.target.value }))}
                placeholder="Kuala Lumpur"
                className={`min-h-11 w-full rounded-lg border border-[color:var(--line-soft)] bg-[color:var(--surface-1)] px-4 text-[color:var(--text)] placeholder:text-[color:var(--text-faint)] ${FOCUS_RING}`}
              />
            </div>

            <button type="submit" disabled={!originValid} className={BTN_PRIMARY}>
              {originValid ? 'Continue' : 'Waiting for your city'}
            </button>
          </form>

          <button type="button" onClick={() => void finish(null)} disabled={saving} className={BTN_GHOST}>
            {saving ? 'Saving…' : 'Skip for now'}
          </button>
        </section>
      ) : (
        <section>
          <h1
            className="mb-6 font-display text-[22px] font-medium leading-[1.22] tracking-[-0.015em]"
            style={{ fontVariationSettings: "'SOFT' 28, 'WONK' 1, 'opsz' 22" }}
          >
            What pace do you like?
          </h1>

          <div role="group" aria-label="Travel pace" className="flex flex-col gap-2">
            {PACE.map((p) => {
              const on = pace === p.tag
              return (
                <button
                  key={p.tag}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setPace(p.tag)}
                  className={`block w-full rounded-lg border bg-[color:var(--surface-1)] px-4 py-3 text-left transition-colors ${FOCUS_RING} ${
                    on ? 'border-[color:var(--accent)]' : 'border-[color:var(--line-soft)] hover:bg-[color:var(--surface-2)]'
                  }`}
                >
                  <span className="block text-[15px] font-semibold text-[color:var(--text)]">{p.name}</span>
                  <span className="mt-0.5 block text-[13px] text-[color:var(--text-muted)]">{p.what}</span>
                </button>
              )
            })}
          </div>

          <button type="button" onClick={() => void finish(pace)} disabled={!pace || saving} className={`${BTN_PRIMARY} mt-6`}>
            {saving ? 'Saving…' : pace ? 'Finish' : 'Waiting for your pace'}
          </button>

          <button type="button" onClick={() => void finish(null)} disabled={saving} className={BTN_GHOST}>
            Skip for now
          </button>

          <p className="mt-6 border-t border-[color:var(--line-soft)] pt-4 text-[13px] text-[color:var(--text-muted)]">
            Both answers live in your settings. Astrail also learns from the trips you keep.
          </p>
        </section>
      )}

      {saveError ? (
        <p role="alert" className="mt-3 text-[13px] text-[color:var(--fail)]">
          {saveError}
        </p>
      ) : null}
    </DoorStage>
  )
}
