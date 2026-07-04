# Astrail Onboarding Wizard Implementation Plan (Plan 4 of 5)

> **For the executing engineer (Codex):** You have **zero prior context** for this codebase. Everything you need is in this document — exact file paths, complete code, exact commands, and expected output. Implement task-by-task in order. Each task is TDD: write the failing test, run it (see it fail), transcribe the implementation **verbatim**, run it (see it pass), then commit. Do not skip the "run to verify it fails" step. Do not add dependencies. Do not import anything from `legacy/`.
>
> If a test fails for a purely **mechanical** reason (an import path, a Vitest `vi.mock` hoisting error, an accessible-role/label query that doesn't match the component's real markup), fix the *test mechanics* — never weaken an assertion to make it pass. If an assertion genuinely can't pass, stop and report; do not delete or loosen it.

**Goal:** Build a `/app/onboarding` multi-step wizard that collects a traveler's origin, travel-style tags, interests, and free-text notes, then persists a completed mock `TravelerProfile` through the mock-api seam and routes into `/app` — fully offline and deterministic.

**Architecture:** A client `OnboardingWizard` orchestrator holds a draft + a step index (`origin → style → interests → notes → review`) and renders each step's fields inline, reusing a `ChipMultiSelect` for the tag steps. Pure step/vocabulary/validation logic lives in a unit-tested `lib/onboarding/onboarding.ts`. On Finish, the wizard calls the mock seam `saveProfile(input)` (which returns a profile with `onboarding_completed: true`) and routes to `/app`.

**Tech Stack:** Next.js 15.5 (App Router) · React 19.2 · TypeScript 5.9 · Tailwind CSS v4 (config-free, `@import "tailwindcss"`) · Vitest 2 + @testing-library/react (jsdom). No new dependencies.

## Global Constraints

- **Package manager:** npm. Run **every** command from `C:\Github\astrail\frontend` (the Next.js app root). On non-Windows shells the directory is the repo's `frontend/`.
- **Types:** Consume only the snake_case DB-shaped types from `@/lib/trip/backend-types`. The `@/` alias maps to `frontend/` (e.g. `@/lib/trip/backend-types` → `frontend/lib/trip/backend-types.ts`).
- **SCHEMA PARITY (guardrail #4 — critical):** `TravelerProfile` has exactly these fields: `id`, `origin_city`, `travel_style_tags`, `preference_tags`, `preference_notes`, `onboarding_completed`. It has **NO** `budget` or `pace` column. The PRD lists "budget/pace defaults" as an onboarding topic, but you MUST capture those as free-form entries in `travel_style_tags` (e.g. an option like `budget-conscious`) — **never add a new profile field.** Do not invent columns.
- **Data seam:** Components get data **only** through `@/lib/trip/mock-api`. Never import `@/lib/trip/fixtures` in component source (tests may). Never import `@/lib/trip/api` or `@/lib/trip/sse`.
- **Styling:** Reuse the existing design tokens in `app/globals.css`. Colors via CSS vars through Tailwind arbitrary values: `bg-[var(--void)]`, `text-[var(--starlight)]`, `text-[var(--muted)]`, `text-[var(--faint)]`, `text-[var(--brass)]`, `border-[var(--line)]`, `bg-[var(--brass-soft)]`. Use utility classes `.surface` (panel bg+border), `.type-display` (serif), `.type-body`, `.type-label` (mono). Brass `#C9974E` is the single accent.
- **Icons:** Inline SVG only. No icon library (STACK is frozen — no new deps).
- **Onboarding is a soft gate (PRD §6):** the wizard is orderable, not hard-blocking. Do not add middleware gates or forced redirects. Finish requires at least one style OR interest tag (so the profile is meaningful); everything else is optional.
- **Do NOT write `UserPreferenceFact`s.** Fact distillation is a backend concern. The wizard writes only a `TravelerProfile` via `saveProfile`.
- **Client directive:** Any component with an event handler, a hook, or browser APIs starts with `'use client'`. `app/app/onboarding/page.tsx` stays a server component that renders the client wizard.
- **Tests:** Vitest + @testing-library/react. Import `describe, it, expect, vi, beforeEach` from `'vitest'` and `render, screen, fireEvent, waitFor` from `'@testing-library/react'`.
- **Commits:** One commit per task, present-tense `feat(frontend): …`. A `.githooks/post-commit` prompt may appear and auto-skips after 15s — let it; do not answer it.
- **Green gate:** Before every commit, `npm test` (full suite) passes and `npm run typecheck` exits 0.

---

## Existing types you will consume (already defined — do NOT redefine)

From `frontend/lib/trip/backend-types.ts`:

```ts
export type TravelerProfile = {
  id: string
  origin_city: string | null
  travel_style_tags: string[]
  preference_tags: string[]
  preference_notes: string | null
  onboarding_completed: boolean
}
```

The mock seam `frontend/lib/trip/mock-api.ts` already has `getProfile()` and (from Plan 3) `createTrip`; it uses a module-local `delay(MOCK_LATENCY_MS)` and imports `DEMO_PROFILE` from `@/lib/trip/fixtures`. Task 2 adds `saveProfile` next to them.

---

## File Structure

- `lib/onboarding/onboarding.ts` (new) — pure module: draft type, vocabularies, `STEPS`, `toggleTag`, `canFinish`, `toProfileInput`.
- `lib/onboarding/__tests__/onboarding.test.ts` (new) — unit tests.
- `lib/trip/mock-api.ts` (modify) — add `saveProfile(input): Promise<TravelerProfile>`.
- `lib/trip/__tests__/mock-api.test.ts` (modify) — add `saveProfile` tests.
- `components/onboarding/ChipMultiSelect.tsx` (new, client) — reusable toggle-chip group.
- `components/onboarding/__tests__/ChipMultiSelect.test.tsx` (new).
- `components/onboarding/OnboardingWizard.tsx` (new, client) — orchestrator + steps + finish.
- `components/onboarding/__tests__/OnboardingWizard.test.tsx` (new).
- `app/app/onboarding/page.tsx` (new) — server wrapper rendering `<OnboardingWizard />`.

---

## Task 1: Onboarding model

**Files:**
- Create: `lib/onboarding/onboarding.ts`
- Test: `lib/onboarding/__tests__/onboarding.test.ts`

**Interfaces:**
- Produces (later tasks rely on these **exact** names/signatures):
  - type `OnboardingDraft = { origin_city: string; travel_style_tags: string[]; preference_tags: string[]; preference_notes: string }`
  - type `ProfileInput = { origin_city: string | null; travel_style_tags: string[]; preference_tags: string[]; preference_notes: string | null }`
  - `EMPTY_DRAFT: OnboardingDraft`
  - `TRAVEL_STYLE_OPTIONS: readonly string[]`, `INTEREST_OPTIONS: readonly string[]`
  - `STEPS: readonly { key: string; title: string }[]` (last step's `key` is `'review'`)
  - `toggleTag(tags: string[], tag: string): string[]`
  - `canFinish(draft: OnboardingDraft): boolean`
  - `toProfileInput(draft: OnboardingDraft): ProfileInput`

- [ ] **Step 1: Write the failing test**

```ts
// lib/onboarding/__tests__/onboarding.test.ts
import { describe, it, expect } from 'vitest'
import {
  EMPTY_DRAFT, TRAVEL_STYLE_OPTIONS, INTEREST_OPTIONS, STEPS,
  toggleTag, canFinish, toProfileInput, type OnboardingDraft,
} from '@/lib/onboarding/onboarding'

describe('toggleTag', () => {
  it('adds a tag when absent and removes it when present', () => {
    expect(toggleTag([], 'a')).toEqual(['a'])
    expect(toggleTag(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('canFinish', () => {
  it('is false with no style and no interest tags', () => {
    expect(canFinish(EMPTY_DRAFT)).toBe(false)
  })
  it('is true once a style OR interest tag is chosen', () => {
    expect(canFinish({ ...EMPTY_DRAFT, travel_style_tags: ['food-led'] })).toBe(true)
    expect(canFinish({ ...EMPTY_DRAFT, preference_tags: ['ramen'] })).toBe(true)
  })
})

describe('toProfileInput', () => {
  it('trims blank origin/notes to null and passes tags through', () => {
    const draft: OnboardingDraft = {
      origin_city: '  ', travel_style_tags: ['relaxed'], preference_tags: ['coffee'], preference_notes: '  ',
    }
    expect(toProfileInput(draft)).toEqual({
      origin_city: null, travel_style_tags: ['relaxed'], preference_tags: ['coffee'], preference_notes: null,
    })
  })
  it('keeps trimmed origin and notes', () => {
    const draft: OnboardingDraft = {
      origin_city: ' Tokyo ', travel_style_tags: [], preference_tags: [], preference_notes: ' avoid rushing ',
    }
    const out = toProfileInput(draft)
    expect(out.origin_city).toBe('Tokyo')
    expect(out.preference_notes).toBe('avoid rushing')
  })
})

describe('vocabularies + steps', () => {
  it('exposes non-empty option lists and a 5-step flow ending in review', () => {
    expect(TRAVEL_STYLE_OPTIONS.length).toBeGreaterThan(0)
    expect(INTEREST_OPTIONS.length).toBeGreaterThan(0)
    expect(STEPS.length).toBe(5)
    expect(STEPS[STEPS.length - 1].key).toBe('review')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- onboarding`
Expected: FAIL — `Failed to resolve import "@/lib/onboarding/onboarding"`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/onboarding/onboarding.ts

export type OnboardingDraft = {
  origin_city: string
  travel_style_tags: string[]
  preference_tags: string[]
  preference_notes: string
}

export type ProfileInput = {
  origin_city: string | null
  travel_style_tags: string[]
  preference_tags: string[]
  preference_notes: string | null
}

export const EMPTY_DRAFT: OnboardingDraft = {
  origin_city: '', travel_style_tags: [], preference_tags: [], preference_notes: '',
}

// Design vocabularies. The PRD leaves these open; they imitate the demo fixture
// (food-led / walkable / relaxed · ramen / walkable days / not too rushed).
// NOTE (schema parity): budget/pace are captured here as free-form travel-style tags
// (e.g. `budget-conscious`, `fast-paced`) — TravelerProfile has no budget/pace column.
export const TRAVEL_STYLE_OPTIONS = [
  'food-led', 'walkable', 'relaxed', 'fast-paced', 'adventure',
  'culture', 'nature', 'nightlife', 'luxury', 'budget-conscious',
] as const

export const INTEREST_OPTIONS = [
  'ramen', 'street food', 'coffee', 'museums', 'temples',
  'shopping', 'hiking', 'beaches', 'photography', 'markets',
] as const

export const STEPS = [
  { key: 'origin', title: 'Where do you begin?' },
  { key: 'style', title: 'Your travel style' },
  { key: 'interests', title: 'What are you into?' },
  { key: 'notes', title: 'Anything to remember?' },
  { key: 'review', title: 'Ready for liftoff?' },
] as const

export function toggleTag(tags: string[], tag: string): string[] {
  return tags.includes(tag) ? tags.filter((t) => t !== tag) : [...tags, tag]
}

export function canFinish(draft: OnboardingDraft): boolean {
  return draft.travel_style_tags.length > 0 || draft.preference_tags.length > 0
}

export function toProfileInput(draft: OnboardingDraft): ProfileInput {
  const clean = (s: string): string | null => {
    const t = s.trim()
    return t.length ? t : null
  }
  return {
    origin_city: clean(draft.origin_city),
    travel_style_tags: draft.travel_style_tags,
    preference_tags: draft.preference_tags,
    preference_notes: clean(draft.preference_notes),
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- onboarding`
Expected: PASS — all `onboarding` tests green.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expected: exit 0)

```bash
git add lib/onboarding/onboarding.ts lib/onboarding/__tests__/onboarding.test.ts
git commit -m "feat(frontend): onboarding model (draft, vocabularies, steps, profile mapping)"
```

---

## Task 2: `saveProfile` mock seam

**Files:**
- Modify: `lib/trip/mock-api.ts`
- Test: `lib/trip/__tests__/mock-api.test.ts` (append)

**Interfaces:**
- Consumes: `TravelerProfile` from `@/lib/trip/backend-types`; `DEMO_PROFILE` from `@/lib/trip/fixtures`.
- Produces: `saveProfile(input: { origin_city: string | null; travel_style_tags: string[]; preference_tags: string[]; preference_notes: string | null }): Promise<TravelerProfile>` — resolves a profile echoing the input with `onboarding_completed: true`.

- [ ] **Step 1: Write the failing test**

First edit the imports at the top of `lib/trip/__tests__/mock-api.test.ts`. Add `saveProfile` to the existing `@/lib/trip/mock-api` import (it currently lists `getTrip, listTrips, getProfile, submitFeedback, streamGeneration, createTrip` after Plan 3). The line becomes:

```ts
import { getTrip, listTrips, getProfile, submitFeedback, streamGeneration, createTrip, saveProfile } from '@/lib/trip/mock-api'
```

Then append this block as a **sibling** `describe` at the very end of the file:

```ts
describe('saveProfile', () => {
  it('returns a completed profile echoing the onboarding input', async () => {
    const res = await saveProfile({
      origin_city: 'Tokyo',
      travel_style_tags: ['food-led', 'walkable'],
      preference_tags: ['ramen'],
      preference_notes: 'avoid rushing',
    })
    expect(res.onboarding_completed).toBe(true)
    expect(res.origin_city).toBe('Tokyo')
    expect(res.travel_style_tags).toEqual(['food-led', 'walkable'])
    expect(res.preference_tags).toEqual(['ramen'])
    expect(res.preference_notes).toBe('avoid rushing')
  })

  it('accepts null origin and notes and still completes onboarding', async () => {
    const res = await saveProfile({
      origin_city: null, travel_style_tags: [], preference_tags: [], preference_notes: null,
    })
    expect(res.onboarding_completed).toBe(true)
    expect(res.origin_city).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- mock-api`
Expected: FAIL — `saveProfile is not a function` (or an import error for `saveProfile`).

- [ ] **Step 3: Write the implementation**

Add to `lib/trip/mock-api.ts` (place it just below the `createTrip` function). `TravelerProfile` and `DEMO_PROFILE` are already imported at the top of the file — do not re-import them.

```ts
// Simulates PATCH /profile: persists the onboarding answers and marks onboarding complete.
// Offline/deterministic — echoes the input on the demo profile id.
export async function saveProfile(input: {
  origin_city: string | null
  travel_style_tags: string[]
  preference_tags: string[]
  preference_notes: string | null
}): Promise<TravelerProfile> {
  await delay(MOCK_LATENCY_MS)
  return {
    id: DEMO_PROFILE.id,
    origin_city: input.origin_city,
    travel_style_tags: input.travel_style_tags,
    preference_tags: input.preference_tags,
    preference_notes: input.preference_notes,
    onboarding_completed: true,
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- mock-api`
Expected: PASS — including the two new `saveProfile` cases.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expected: exit 0)

```bash
git add lib/trip/mock-api.ts lib/trip/__tests__/mock-api.test.ts
git commit -m "feat(frontend): add saveProfile to the mock-api seam"
```

---

## Task 3: ChipMultiSelect component

**Files:**
- Create: `components/onboarding/ChipMultiSelect.tsx`
- Test: `components/onboarding/__tests__/ChipMultiSelect.test.tsx`

**Interfaces:**
- Produces: `<ChipMultiSelect options={readonly string[]} selected={string[]} onToggle={(value: string) => void} ariaLabel={string} />` (default export, `'use client'`). Each option is a toggle button carrying `aria-pressed`.

- [ ] **Step 1: Write the failing test**

```tsx
// components/onboarding/__tests__/ChipMultiSelect.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ChipMultiSelect from '@/components/onboarding/ChipMultiSelect'

describe('ChipMultiSelect', () => {
  it('renders every option as a toggle button', () => {
    render(<ChipMultiSelect ariaLabel="Style" options={['a', 'b', 'c']} selected={[]} onToggle={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'a' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'c' })).toBeInTheDocument()
  })

  it('marks selected options with aria-pressed', () => {
    render(<ChipMultiSelect ariaLabel="Style" options={['a', 'b']} selected={['b']} onToggle={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'a' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: 'b' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('calls onToggle with the clicked option', () => {
    const onToggle = vi.fn()
    render(<ChipMultiSelect ariaLabel="Style" options={['a', 'b']} selected={[]} onToggle={onToggle} />)
    fireEvent.click(screen.getByRole('button', { name: 'b' }))
    expect(onToggle).toHaveBeenCalledWith('b')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- ChipMultiSelect`
Expected: FAIL — cannot resolve `@/components/onboarding/ChipMultiSelect`.

- [ ] **Step 3: Write the implementation**

```tsx
// components/onboarding/ChipMultiSelect.tsx
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- ChipMultiSelect`
Expected: PASS — all three cases.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expected: exit 0)

```bash
git add components/onboarding/ChipMultiSelect.tsx components/onboarding/__tests__/ChipMultiSelect.test.tsx
git commit -m "feat(frontend): reusable chip multi-select"
```

---

## Task 4: OnboardingWizard + wire `/app/onboarding`

**Files:**
- Create: `components/onboarding/OnboardingWizard.tsx`
- Test: `components/onboarding/__tests__/OnboardingWizard.test.tsx`
- Create: `app/app/onboarding/page.tsx`

**Interfaces:**
- Consumes: `saveProfile` from `@/lib/trip/mock-api`; `EMPTY_DRAFT`, `STEPS`, `TRAVEL_STYLE_OPTIONS`, `INTEREST_OPTIONS`, `toggleTag`, `toProfileInput`, `canFinish`, `OnboardingDraft` from `@/lib/onboarding/onboarding`; `useRouter` from `next/navigation`; `ChipMultiSelect` from Task 3.
- Produces: `<OnboardingWizard />` (default export, no props). Holds `draft`, `stepIndex`, `saving`.

> **Vitest mock note (READ THIS):** `vi.mock(...)` factories are hoisted **above** the file's imports and top-level `const`s. Referencing a top-level `const` inside a factory throws a temporal-dead-zone `ReferenceError`. Define every value a factory needs inside `vi.hoisted(...)`, exactly as written below.
>
> **Lifecycle note (READ THIS):** `saveProfile` is async. The wizard's `finish()` guards with a mounted-ref before `router.push`, so an unmount during the pending save cannot navigate on a dead component. Transcribe the `activeRef` code exactly — do not remove it.

- [ ] **Step 1: Write the failing test**

```tsx
// components/onboarding/__tests__/OnboardingWizard.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { push, saveProfile } = vi.hoisted(() => ({
  push: vi.fn(),
  saveProfile: vi.fn(async (input: unknown) => ({ id: 'demo-user', ...(input as object), onboarding_completed: true })),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/lib/trip/mock-api', () => ({ saveProfile }))

import OnboardingWizard from '@/components/onboarding/OnboardingWizard'

const clickNext = () => fireEvent.click(screen.getByRole('button', { name: /^next$/i }))

describe('OnboardingWizard', () => {
  beforeEach(() => { push.mockClear(); saveProfile.mockClear() })

  it('walks the steps, saves the profile, and routes to /app', async () => {
    render(<OnboardingWizard />)
    fireEvent.change(screen.getByLabelText(/origin city/i), { target: { value: 'Tokyo' } })
    clickNext()
    fireEvent.click(screen.getByRole('button', { name: /^food-led$/i }))
    clickNext()
    fireEvent.click(screen.getByRole('button', { name: /^ramen$/i }))
    clickNext()
    fireEvent.change(screen.getByLabelText(/remember/i), { target: { value: 'avoid rushing' } })
    clickNext()
    fireEvent.click(screen.getByRole('button', { name: /finish/i }))

    await waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(1))
    expect(saveProfile).toHaveBeenCalledWith({
      origin_city: 'Tokyo',
      travel_style_tags: ['food-led'],
      preference_tags: ['ramen'],
      preference_notes: 'avoid rushing',
    })
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app'))
  })

  it('disables Finish until at least one style or interest tag is chosen', () => {
    render(<OnboardingWizard />)
    for (let i = 0; i < 4; i++) clickNext() // advance to the review step selecting nothing
    expect(screen.getByRole('button', { name: /finish/i })).toBeDisabled()
  })

  it('toggles a chip aria-pressed on click', () => {
    render(<OnboardingWizard />)
    clickNext() // to the style step
    const chip = screen.getByRole('button', { name: /^food-led$/i })
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'true')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- OnboardingWizard`
Expected: FAIL — cannot resolve `@/components/onboarding/OnboardingWizard`.

- [ ] **Step 3: Write the implementation**

```tsx
// components/onboarding/OnboardingWizard.tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { saveProfile } from '@/lib/trip/mock-api'
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
    await saveProfile(toProfileInput(draft))
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- OnboardingWizard`
Expected: PASS — all three cases.

- [ ] **Step 5: Wire the route**

Create `app/app/onboarding/page.tsx` with exactly:

```tsx
// app/app/onboarding/page.tsx
import OnboardingWizard from '@/components/onboarding/OnboardingWizard'

export default function OnboardingPage() {
  return <OnboardingWizard />
}
```

- [ ] **Step 6: Run the FULL suite + typecheck**

Run: `npm test` — expected: ALL test files pass (Plan 1 + Plan 2 + Plan 3 suites plus the four new files from Tasks 1–4). Report the file/test counts.
Run: `npm run typecheck` — expected: exit 0, no output.

- [ ] **Step 7: Commit**

```bash
git add components/onboarding/OnboardingWizard.tsx components/onboarding/__tests__/OnboardingWizard.test.tsx app/app/onboarding/page.tsx
git commit -m "feat(frontend): onboarding wizard wired at /app/onboarding"
```

---

## Self-Review (run by the plan author, already done)

**Spec coverage vs. PRD §6 onboarding topics:** bio → `preference_notes` (Step 4); travel style → `travel_style_tags` chips (Step 2); food/activity → `preference_tags` chips (Step 3); budget/pace → captured as `travel_style_tags` (e.g. `budget-conscious`, `fast-paced`), NOT a new field (schema parity); avoidances → free-text notes. Origin → `origin_city` (Step 1). Completion flips `onboarding_completed: true` (Task 2) and routes to `/app` (Task 4). ✅

**Schema parity:** `saveProfile` and `toProfileInput` write only the six real `TravelerProfile` fields. No `budget`/`pace` column is invented. ✅

**Type consistency:** `OnboardingDraft`/`ProfileInput` defined once in Task 1; `toProfileInput` returns exactly the `saveProfile` input shape; `saveProfile` returns `TravelerProfile`. `ChipMultiSelect` prop names match the wizard's usage. No drift.

**Lifecycle:** the `finish()` mounted-guard mirrors the Plan 3 fix that review flagged — applied proactively here.

**Placeholder scan:** every step has complete code, an exact command, and expected output. No TODO/TBD.

---

## Execution & Review Handoff

- **Executor:** Codex, task-by-task (TDD, one commit per task, verbatim transcription). If a test needs a mechanical fix (import path / `vi.mock` hoisting / accessible-name query), fix the *test mechanics* without weakening any assertion, and note it in the commit body. If you find a genuine spec/code bug (as happened twice in Plan 3), STOP before committing and report it rather than deviating silently.
- **Reviewer:** the planning agent (Opus) reviews each commit's diff for spec compliance, schema parity, seam purity, and non-vacuous tests, then runs a final whole-branch review + browser verification (load `/app/onboarding` with `NEXT_PUBLIC_MOCK_AUTH=true`: walk the steps, select chips, Finish, confirm it lands on `/app`).
- **Out of scope (later plan / deferred):** an entry CTA to onboarding from `/app` (checking `getProfile().onboarding_completed`); a hard onboarding gate; writing `UserPreferenceFact`s; editing the profile after completion (Plan 5 Settings covers profile display).
