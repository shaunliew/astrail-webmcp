# Astrail Trip List + Settings Implementation Plan (Plan 5 of 5)

> **For the executing engineer (Codex):** You have **zero prior context** for this codebase. Everything you need is in this document — exact file paths, complete code, exact commands, and expected output. Implement task-by-task in order. Each task is TDD: write the failing test, run it (see it fail), transcribe the implementation **verbatim**, run it (see it pass), then commit. Do not skip the "run to verify it fails" step. Do not add dependencies. Do not import anything from `legacy/`.
>
> If a test fails for a purely **mechanical** reason (an import path, a Vitest `vi.mock` hoisting error, an accessible-role/name query that doesn't match the component's real markup, a `next/link` needing a router context in jsdom), fix the *test mechanics* — never weaken an assertion to make it pass. If an assertion genuinely can't pass, stop and report; do not delete or loosen it.

**Goal:** Build the two remaining shell surfaces — a Trip list at `/app/trips` (grid of saved trips via `listTrips`, each card linking to its trip view) and a Settings page at `/app/settings` (traveler preference summary + a memory receipt of learned facts + a mock clear-memory action) — all reading the mock-api seam, offline and deterministic.

**Architecture:** Pure display logic lives in unit-tested presenter modules (`lib/trip/trip-presenters.ts` for Trip formatting, `lib/profile/memory.ts` for receipt lines). Two client containers fetch from the seam with a mounted-guard: `TripsList` (`listTrips` → grid of `TripCard`s, with loading + empty states) and `SettingsView` (`getProfile` → profile summary + memory receipt + clear-memory). A tiny `clearMemory` seam addition backs the settings action.

**Tech Stack:** Next.js 15.5 (App Router) · React 19.2 · TypeScript 5.9 · Tailwind CSS v4 (config-free, `@import "tailwindcss"`) · Vitest 2 + @testing-library/react (jsdom). No new dependencies.

## Global Constraints

- **Package manager:** npm. Run **every** command from `C:\Github\astrail\frontend` (the Next.js app root). On non-Windows shells the directory is the repo's `frontend/`.
- **Types:** Consume only the snake_case DB-shaped types from `@/lib/trip/backend-types`. The `@/` alias maps to `frontend/`.
- **SCHEMA PARITY (guardrail #4):** render only real fields. `Trip` has `id, user_id, status, destination_hint, inferred_destination, start_date, end_date, origin_city, budget_level, adult_count, child_count, room_count, preference_sources, preference_summary, created_at, updated_at` — there is **no** `place_count`, `thumbnail`, or `title` field, so cards must NOT show a place count or image (no data source). `TravelerProfile` has `id, origin_city, travel_style_tags, preference_tags, preference_notes, onboarding_completed`. `UserPreferenceFact` has `id, user_id, category, fact_key, fact_value, source, confidence, status`. Never invent a field.
- **Data seam:** Components get data **only** through `@/lib/trip/mock-api`. Never import `@/lib/trip/fixtures` in component source (tests may). Never import `@/lib/trip/api` or `@/lib/trip/sse`.
- **Styling:** Reuse the design tokens in `app/globals.css`. Colors via CSS vars through Tailwind arbitrary values: `bg-[var(--void)]`, `text-[var(--starlight)]`, `text-[var(--muted)]`, `text-[var(--faint)]`, `text-[var(--brass)]`, `border-[var(--line)]`, `bg-[var(--brass-soft)]`. Utility classes `.surface`, `.type-display`, `.type-body`, `.type-label`. Brass `#C9974E` is the single accent.
- **Icons:** Inline SVG or text glyphs only. No icon library (STACK is frozen — no new deps).
- **Fetch lifecycle:** every client fetch uses a mounted-guard (`activeRef`) so a resolve after unmount does not `setState` / navigate on a dead component. (Same pattern used in Plan 3/4.)
- **Client directive:** Any component with a hook, event handler, or browser API starts with `'use client'`. The two `page.tsx` files stay server components that render the client container.
- **Tests:** Vitest + @testing-library/react. Import `describe, it, expect, vi, beforeEach` from `'vitest'` and `render, screen, fireEvent, waitFor` from `'@testing-library/react'`. Fixture data (tests only) via `import { TOKYO_TRIP, DEMO_PROFILE, DEMO_PREFERENCE_FACTS } from '@/lib/trip/fixtures'`.
- **Commits:** One commit per task, present-tense `feat(frontend): …`. A `.githooks/post-commit` prompt may appear and auto-skips after 15s — let it.
- **Green gate:** Before every commit, `npm test` (full suite) passes and `npm run typecheck` exits 0.

---

## Existing seam + types you will consume (already defined — do NOT redefine)

From `frontend/lib/trip/mock-api.ts`: `listTrips(): Promise<Trip[]>` (returns the demo trip), `getProfile(): Promise<{ profile: TravelerProfile; facts: UserPreferenceFact[] }>`. Task 4 adds `clearMemory`.

The demo fixture facts (`DEMO_PREFERENCE_FACTS`, all `status: 'active'`): `likes_cuisine='ramen'`, `prefers='walkable days'`, `avoids='rushed itineraries'`, `style='mid_range'`.

---

## File Structure

- `lib/trip/trip-presenters.ts` (new) — pure: `tripTitle`, `tripDateRange`, `tripStatusLabel`, `budgetLabel`.
- `lib/trip/__tests__/trip-presenters.test.ts` (new).
- `components/trips/TripCard.tsx` (new) — one trip, links to its view.
- `components/trips/__tests__/TripCard.test.tsx` (new).
- `components/trips/TripsList.tsx` (new, client) — fetch + loading/empty/grid.
- `components/trips/__tests__/TripsList.test.tsx` (new).
- `app/app/trips/page.tsx` (rewrite the `<main />` stub) — render `<TripsList />`.
- `lib/trip/mock-api.ts` (modify) — add `clearMemory`.
- `lib/trip/__tests__/mock-api.test.ts` (modify) — add `clearMemory` test.
- `lib/profile/memory.ts` (new) — pure: `factToReceiptLine`, `memoryReceiptLines`.
- `lib/profile/__tests__/memory.test.ts` (new).
- `components/settings/SettingsView.tsx` (new, client) — fetch + summary + receipt + clear.
- `components/settings/__tests__/SettingsView.test.tsx` (new).
- `app/app/settings/page.tsx` (rewrite the `<main />` stub) — render `<SettingsView />`.

---

## Task 1: Trip presenters

**Files:**
- Create: `lib/trip/trip-presenters.ts`
- Test: `lib/trip/__tests__/trip-presenters.test.ts`

**Interfaces:**
- Consumes: `Trip`, `TripStatus`, `BudgetLevel` from `@/lib/trip/backend-types`.
- Produces: `tripTitle(trip: Trip): string`, `tripDateRange(trip: Trip): string`, `tripStatusLabel(status: TripStatus): string`, `budgetLabel(budget: BudgetLevel | null): string`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/trip/__tests__/trip-presenters.test.ts
import { describe, it, expect } from 'vitest'
import { tripTitle, tripDateRange, tripStatusLabel, budgetLabel } from '@/lib/trip/trip-presenters'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import type { Trip } from '@/lib/trip/backend-types'

const base: Trip = { ...TOKYO_TRIP.trip }

describe('tripTitle', () => {
  it('prefers inferred_destination, falls back to hint then Untitled', () => {
    expect(tripTitle({ ...base, inferred_destination: 'Tokyo, Japan' })).toBe('Tokyo, Japan')
    expect(tripTitle({ ...base, inferred_destination: null, destination_hint: 'Tokyo' })).toBe('Tokyo')
    expect(tripTitle({ ...base, inferred_destination: null, destination_hint: null })).toBe('Untitled trip')
  })
})

describe('tripDateRange', () => {
  it('formats a start–end range, a lone start, or a flexible fallback', () => {
    const range = tripDateRange({ ...base, start_date: '2026-08-14', end_date: '2026-08-16' })
    expect(range).toMatch(/14/)
    expect(range).toMatch(/16/)
    expect(tripDateRange({ ...base, start_date: '2026-08-14', end_date: null })).toMatch(/14/)
    expect(tripDateRange({ ...base, start_date: null, end_date: null })).toBe('Dates flexible')
  })
})

describe('tripStatusLabel', () => {
  it('maps statuses to human labels', () => {
    expect(tripStatusLabel('saved_with_gaps')).toBe('Saved with gaps')
    expect(tripStatusLabel('complete')).toBe('Complete')
  })
})

describe('budgetLabel', () => {
  it('labels a level or falls back for null', () => {
    expect(budgetLabel('mid_range')).toBe('Mid-range')
    expect(budgetLabel(null)).toBe('Any budget')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- trip-presenters`
Expected: FAIL — `Failed to resolve import "@/lib/trip/trip-presenters"`.

- [ ] **Step 3: Write the implementation**

```ts
// lib/trip/trip-presenters.ts
import type { Trip, TripStatus, BudgetLevel } from '@/lib/trip/backend-types'

export function tripTitle(trip: Trip): string {
  return trip.inferred_destination ?? trip.destination_hint ?? 'Untitled trip'
}

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function tripDateRange(trip: Trip): string {
  if (trip.start_date && trip.end_date) return `${shortDate(trip.start_date)} – ${shortDate(trip.end_date)}`
  if (trip.start_date) return shortDate(trip.start_date)
  return 'Dates flexible'
}

const STATUS_LABEL: Record<TripStatus, string> = {
  draft: 'Draft',
  generating: 'Generating',
  places_ready: 'Places ready',
  complete: 'Complete',
  saved_with_gaps: 'Saved with gaps',
  failed: 'Failed',
}

export function tripStatusLabel(status: TripStatus): string {
  return STATUS_LABEL[status]
}

const BUDGET_LABEL: Record<BudgetLevel, string> = {
  budget: 'Budget',
  mid_range: 'Mid-range',
  premium: 'Premium',
  luxury: 'Luxury',
}

export function budgetLabel(budget: BudgetLevel | null): string {
  return budget ? BUDGET_LABEL[budget] : 'Any budget'
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- trip-presenters`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expected: exit 0)

```bash
git add lib/trip/trip-presenters.ts lib/trip/__tests__/trip-presenters.test.ts
git commit -m "feat(frontend): trip card presenters (title, date range, status, budget)"
```

---

## Task 2: TripCard component

**Files:**
- Create: `components/trips/TripCard.tsx`
- Test: `components/trips/__tests__/TripCard.test.tsx`

**Interfaces:**
- Consumes: `Trip` from `@/lib/trip/backend-types`; the four presenters from Task 1; `Link` from `next/link`.
- Produces: `<TripCard trip={Trip} />` (default export). Renders a `next/link` to `/app/trip/{trip.id}`.

> **Test note:** `next/link` in the App Router can require a router context in jsdom. The test below mocks it to a plain `<a>` so the link renders deterministically. The `vi.mock('next/link', …)` factory is self-contained (no external refs) so it hoists safely.

- [ ] **Step 1: Write the failing test**

```tsx
// components/trips/__tests__/TripCard.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    <a href={typeof href === 'string' ? href : ''} {...props}>{children}</a>,
}))

import TripCard from '@/components/trips/TripCard'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

describe('TripCard', () => {
  it('links to the trip view and shows its title and status', () => {
    render(<TripCard trip={TOKYO_TRIP.trip} />)
    expect(screen.getByRole('link')).toHaveAttribute('href', `/app/trip/${TOKYO_TRIP.trip.id}`)
    expect(screen.getByRole('heading', { name: /tokyo/i })).toBeInTheDocument()
    expect(screen.getByText(/saved with gaps/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- TripCard`
Expected: FAIL — cannot resolve `@/components/trips/TripCard`.

- [ ] **Step 3: Write the implementation**

```tsx
// components/trips/TripCard.tsx
import Link from 'next/link'
import type { Trip } from '@/lib/trip/backend-types'
import { tripTitle, tripDateRange, tripStatusLabel, budgetLabel } from '@/lib/trip/trip-presenters'

export default function TripCard({ trip }: { trip: Trip }) {
  return (
    <Link
      href={`/app/trip/${trip.id}`}
      className="surface flex flex-col gap-2 rounded-xl p-4 transition-colors hover:border-[var(--brass)]"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="type-display text-lg text-[var(--starlight)]">{tripTitle(trip)}</h3>
        <span className="type-label shrink-0 rounded-full border border-[var(--line)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--brass)]">
          {tripStatusLabel(trip.status)}
        </span>
      </div>
      <p className="type-body text-sm text-[var(--muted)]">{tripDateRange(trip)}</p>
      <div className="type-label flex flex-wrap gap-x-3 gap-y-1 text-[10px] uppercase tracking-wide text-[var(--faint)]">
        <span>{budgetLabel(trip.budget_level)}</span>
        {trip.origin_city ? <span>from {trip.origin_city}</span> : null}
      </div>
    </Link>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- TripCard`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expected: exit 0)

```bash
git add components/trips/TripCard.tsx components/trips/__tests__/TripCard.test.tsx
git commit -m "feat(frontend): trip card"
```

---

## Task 3: TripsList + wire `/app/trips`

**Files:**
- Create: `components/trips/TripsList.tsx`
- Test: `components/trips/__tests__/TripsList.test.tsx`
- Rewrite: `app/app/trips/page.tsx`

**Interfaces:**
- Consumes: `listTrips` from `@/lib/trip/mock-api`; `Trip` from `@/lib/trip/backend-types`; `TripCard` from Task 2; `Link` from `next/link`.
- Produces: `<TripsList />` (default export, `'use client'`). Fetches on mount, renders loading → (empty state | grid of cards).

> **Vitest mock note:** the `listTrips` mock uses `vi.hoisted` so the `vi.mock` factory can reference it without a temporal-dead-zone error. The `next/link` mock is self-contained.

- [ ] **Step 1: Write the failing test**

```tsx
// components/trips/__tests__/TripsList.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    <a href={typeof href === 'string' ? href : ''} {...props}>{children}</a>,
}))

const { listTrips } = vi.hoisted(() => ({ listTrips: vi.fn() }))
vi.mock('@/lib/trip/mock-api', () => ({ listTrips }))

import TripsList from '@/components/trips/TripsList'

describe('TripsList', () => {
  beforeEach(() => { listTrips.mockReset() })

  it('renders a card linking to the trip once loaded', async () => {
    listTrips.mockResolvedValueOnce([TOKYO_TRIP.trip])
    render(<TripsList />)
    expect(await screen.findByRole('heading', { name: /tokyo/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /tokyo/i })).toHaveAttribute('href', `/app/trip/${TOKYO_TRIP.trip.id}`)
  })

  it('shows an empty state when there are no trips', async () => {
    listTrips.mockResolvedValueOnce([])
    render(<TripsList />)
    expect(await screen.findByText(/no trips yet/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- TripsList`
Expected: FAIL — cannot resolve `@/components/trips/TripsList`.

- [ ] **Step 3: Write the implementation**

```tsx
// components/trips/TripsList.tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { listTrips } from '@/lib/trip/mock-api'
import type { Trip } from '@/lib/trip/backend-types'
import TripCard from './TripCard'

export default function TripsList() {
  const [trips, setTrips] = useState<Trip[] | null>(null)
  const activeRef = useRef(true)

  useEffect(() => {
    activeRef.current = true
    listTrips().then((t) => { if (activeRef.current) setTrips(t) })
    return () => { activeRef.current = false }
  }, [])

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-4xl flex-col gap-6 bg-[var(--void)] p-6">
      <header className="flex items-center justify-between">
        <h1 className="type-display text-3xl text-[var(--starlight)]">Your trips</h1>
        <Link
          href="/app"
          className="type-label rounded-lg border border-[var(--brass)] bg-[var(--brass-soft)] px-3 py-2 text-xs uppercase tracking-wide text-[var(--starlight)]"
        >
          New trip
        </Link>
      </header>

      {trips === null ? (
        <p className="type-body text-sm text-[var(--muted)]">Loading your trips…</p>
      ) : trips.length === 0 ? (
        <div className="surface flex flex-col items-start gap-3 rounded-xl p-6">
          <p className="type-body text-sm text-[var(--muted)]">No trips yet. Paste a few Reels to plan your first one.</p>
          <Link href="/app" className="type-label text-xs uppercase tracking-wide text-[var(--brass)]">Start a trip →</Link>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {trips.map((t) => (
            <li key={t.id}><TripCard trip={t} /></li>
          ))}
        </ul>
      )}
    </main>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- TripsList`
Expected: PASS — both cases.

- [ ] **Step 5: Wire the route**

Replace the entire contents of `app/app/trips/page.tsx` with:

```tsx
// app/app/trips/page.tsx
import TripsList from '@/components/trips/TripsList'

export default function TripsPage() {
  return <TripsList />
}
```

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` (expected: exit 0)

```bash
git add components/trips/TripsList.tsx components/trips/__tests__/TripsList.test.tsx app/app/trips/page.tsx
git commit -m "feat(frontend): trip list at /app/trips"
```

---

## Task 4: clearMemory seam + memory receipt presenter

**Files:**
- Modify: `lib/trip/mock-api.ts`
- Test: `lib/trip/__tests__/mock-api.test.ts` (append)
- Create: `lib/profile/memory.ts`
- Test: `lib/profile/__tests__/memory.test.ts`

**Interfaces:**
- Produces: `clearMemory(): Promise<{ ok: true }>` in mock-api; `factToReceiptLine(fact: UserPreferenceFact): string` and `memoryReceiptLines(facts: UserPreferenceFact[]): string[]` in `lib/profile/memory.ts`.

- [ ] **Step 1: Write the failing tests**

First, edit the imports of `lib/trip/__tests__/mock-api.test.ts`. The `@/lib/trip/mock-api` import currently reads `getTrip, listTrips, getProfile, submitFeedback, streamGeneration, createTrip, saveProfile`. Add `clearMemory`, so it becomes:

```ts
import { getTrip, listTrips, getProfile, submitFeedback, streamGeneration, createTrip, saveProfile, clearMemory } from '@/lib/trip/mock-api'
```

Append this block as a **sibling** `describe` at the very end of `lib/trip/__tests__/mock-api.test.ts`:

```ts
describe('clearMemory', () => {
  it('resolves ok', async () => {
    expect(await clearMemory()).toEqual({ ok: true })
  })
})
```

Then create the memory presenter test:

```ts
// lib/profile/__tests__/memory.test.ts
import { describe, it, expect } from 'vitest'
import { factToReceiptLine, memoryReceiptLines } from '@/lib/profile/memory'
import { DEMO_PREFERENCE_FACTS } from '@/lib/trip/fixtures'
import type { UserPreferenceFact } from '@/lib/trip/backend-types'

const mk = (over: Partial<UserPreferenceFact>): UserPreferenceFact => ({
  id: 'x', user_id: 'demo-user', category: 'c', fact_key: 'k', fact_value: 'v',
  source: 'onboarding', confidence: 0.9, status: 'active', ...over,
})

describe('factToReceiptLine', () => {
  it('renders each known fact_key as a human line', () => {
    expect(factToReceiptLine(mk({ fact_key: 'likes_cuisine', fact_value: 'ramen' }))).toBe('Likes ramen')
    expect(factToReceiptLine(mk({ fact_key: 'prefers', fact_value: 'walkable days' }))).toBe('Prefers walkable days')
    expect(factToReceiptLine(mk({ fact_key: 'avoids', fact_value: 'rushed itineraries' }))).toBe('Avoids rushed itineraries')
    expect(factToReceiptLine(mk({ fact_key: 'style', fact_value: 'mid_range' }))).toBe('Budget style: mid-range')
  })
})

describe('memoryReceiptLines', () => {
  it('renders one line per active demo fact', () => {
    expect(memoryReceiptLines(DEMO_PREFERENCE_FACTS)).toEqual([
      'Likes ramen', 'Prefers walkable days', 'Avoids rushed itineraries', 'Budget style: mid-range',
    ])
  })
  it('drops non-active facts', () => {
    const facts = [
      mk({ fact_key: 'likes_cuisine', fact_value: 'ramen' }),
      mk({ status: 'deleted', fact_key: 'avoids', fact_value: 'crowds' }),
    ]
    expect(memoryReceiptLines(facts)).toEqual(['Likes ramen'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- mock-api memory`
Expected: FAIL — `clearMemory is not a function` and `Failed to resolve import "@/lib/profile/memory"`.

- [ ] **Step 3: Write the implementations**

Add to `lib/trip/mock-api.ts` (place it just below the `saveProfile` function):

```ts
// Simulates POST /settings/memory/clear (PRD §18). No-op-but-resolves for the offline shell.
export async function clearMemory(): Promise<{ ok: true }> {
  await delay(MOCK_LATENCY_MS)
  return { ok: true }
}
```

Create `lib/profile/memory.ts`:

```ts
// lib/profile/memory.ts
import type { UserPreferenceFact } from '@/lib/trip/backend-types'

// Turn a structured preference fact into a human "Astrail learned" receipt line.
export function factToReceiptLine(fact: UserPreferenceFact): string {
  const value = String(fact.fact_value).replace(/_/g, '-')
  switch (fact.fact_key) {
    case 'likes_cuisine': return `Likes ${value}`
    case 'prefers': return `Prefers ${value}`
    case 'avoids': return `Avoids ${value}`
    case 'style': return `Budget style: ${value}`
    default: return `${fact.fact_key.replace(/_/g, ' ')}: ${value}`
  }
}

export function memoryReceiptLines(facts: UserPreferenceFact[]): string[] {
  return facts.filter((f) => f.status === 'active').map(factToReceiptLine)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- mock-api memory`
Expected: PASS — `clearMemory` and both `memory` describes green.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expected: exit 0)

```bash
git add lib/trip/mock-api.ts lib/trip/__tests__/mock-api.test.ts lib/profile/memory.ts lib/profile/__tests__/memory.test.ts
git commit -m "feat(frontend): clearMemory seam + memory receipt presenter"
```

---

## Task 5: SettingsView + wire `/app/settings`

**Files:**
- Create: `components/settings/SettingsView.tsx`
- Test: `components/settings/__tests__/SettingsView.test.tsx`
- Rewrite: `app/app/settings/page.tsx`

**Interfaces:**
- Consumes: `getProfile`, `clearMemory` from `@/lib/trip/mock-api`; `TravelerProfile`, `UserPreferenceFact` from `@/lib/trip/backend-types`; `memoryReceiptLines` from `@/lib/profile/memory`.
- Produces: `<SettingsView />` (default export, `'use client'`). Fetches on mount, renders loading → (profile summary + memory receipt + clear-memory button). Clearing swaps the receipt for a cleared message.

> **Vitest mock note:** `getProfile`/`clearMemory` mocks use `vi.hoisted`. **Lifecycle:** the fetch and the clear action both guard with `activeRef` before `setState` — transcribe them exactly.

- [ ] **Step 1: Write the failing test**

```tsx
// components/settings/__tests__/SettingsView.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DEMO_PROFILE, DEMO_PREFERENCE_FACTS } from '@/lib/trip/fixtures'

const { getProfile, clearMemory } = vi.hoisted(() => ({
  getProfile: vi.fn(),
  clearMemory: vi.fn(async () => ({ ok: true as const })),
}))
vi.mock('@/lib/trip/mock-api', () => ({ getProfile, clearMemory }))

import SettingsView from '@/components/settings/SettingsView'

describe('SettingsView', () => {
  beforeEach(() => {
    getProfile.mockResolvedValue({ profile: DEMO_PROFILE, facts: DEMO_PREFERENCE_FACTS })
    clearMemory.mockClear()
  })

  it('renders the profile summary and the memory receipt lines', async () => {
    render(<SettingsView />)
    expect(await screen.findByText('Likes ramen')).toBeInTheDocument()
    expect(screen.getByText('Prefers walkable days')).toBeInTheDocument()
    expect(screen.getByText(/using your saved travel preferences/i)).toBeInTheDocument()
    expect(screen.getByText(/kuala lumpur/i)).toBeInTheDocument()
  })

  it('clears memory and swaps the receipt for a cleared message', async () => {
    render(<SettingsView />)
    await screen.findByText('Likes ramen')
    fireEvent.click(screen.getByRole('button', { name: /clear memory/i }))
    await waitFor(() => expect(clearMemory).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/memory cleared/i)).toBeInTheDocument()
    expect(screen.queryByText('Likes ramen')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- SettingsView`
Expected: FAIL — cannot resolve `@/components/settings/SettingsView`.

- [ ] **Step 3: Write the implementation**

```tsx
// components/settings/SettingsView.tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import { getProfile, clearMemory } from '@/lib/trip/mock-api'
import type { TravelerProfile, UserPreferenceFact } from '@/lib/trip/backend-types'
import { memoryReceiptLines } from '@/lib/profile/memory'

type ProfileData = { profile: TravelerProfile; facts: UserPreferenceFact[] }

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="type-label text-[10px] uppercase tracking-wide text-[var(--faint)]">{label}</dt>
      <dd className="type-body text-sm text-[var(--starlight)]">{value}</dd>
    </div>
  )
}

export default function SettingsView() {
  const [data, setData] = useState<ProfileData | null>(null)
  const [cleared, setCleared] = useState(false)
  const [clearing, setClearing] = useState(false)
  const activeRef = useRef(true)

  useEffect(() => {
    activeRef.current = true
    getProfile().then((d) => { if (activeRef.current) setData(d) })
    return () => { activeRef.current = false }
  }, [])

  async function handleClear() {
    setClearing(true)
    await clearMemory()
    if (!activeRef.current) return
    setCleared(true)
    setClearing(false)
  }

  if (!data) {
    return (
      <main className="mx-auto flex min-h-[100dvh] w-full max-w-2xl items-center justify-center bg-[var(--void)] p-6">
        <p className="type-body text-sm text-[var(--muted)]">Loading your settings…</p>
      </main>
    )
  }

  const { profile } = data
  const lines = memoryReceiptLines(data.facts)

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col gap-8 bg-[var(--void)] p-6">
      <h1 className="type-display text-3xl text-[var(--starlight)]">Settings</h1>

      <section className="surface flex flex-col gap-3 rounded-xl p-5">
        <h2 className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)]">
          Using your saved travel preferences
        </h2>
        <dl className="flex flex-col gap-2">
          <Row label="Origin" value={profile.origin_city ?? 'Not set'} />
          <Row label="Travel style" value={profile.travel_style_tags.join(', ') || 'None yet'} />
          <Row label="Interests" value={profile.preference_tags.join(', ') || 'None yet'} />
          <Row label="Notes" value={profile.preference_notes ?? 'None'} />
        </dl>
      </section>

      <section className="surface flex flex-col gap-3 rounded-xl p-5">
        <h2 className="type-display text-lg text-[var(--starlight)]">Astrail learned:</h2>
        {cleared ? (
          <p className="type-body text-sm text-[var(--muted)]">
            Memory cleared. Astrail will infer fresh preferences next time.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {lines.map((line) => (
              <li key={line} className="type-body flex items-center gap-2 text-sm text-[var(--starlight)]">
                <span aria-hidden className="text-[var(--brass)]">•</span> {line}
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={handleClear}
          disabled={cleared || clearing}
          className="type-label mt-2 self-start rounded-lg border border-[var(--line)] px-3 py-2 text-xs uppercase tracking-wide text-[var(--muted)] transition-colors hover:text-[var(--starlight)] disabled:opacity-40"
        >
          {clearing ? 'Clearing…' : 'Clear memory'}
        </button>
      </section>
    </main>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- SettingsView`
Expected: PASS — both cases.

- [ ] **Step 5: Wire the route**

Replace the entire contents of `app/app/settings/page.tsx` with:

```tsx
// app/app/settings/page.tsx
import SettingsView from '@/components/settings/SettingsView'

export default function SettingsPage() {
  return <SettingsView />
}
```

- [ ] **Step 6: Run the FULL suite + typecheck**

Run: `npm test` — expected: ALL test files pass (Plans 1–4 suites plus the new files from Tasks 1–5). Report the file/test counts.
Run: `npm run typecheck` — expected: exit 0, no output.

- [ ] **Step 7: Commit**

```bash
git add components/settings/SettingsView.tsx components/settings/__tests__/SettingsView.test.tsx app/app/settings/page.tsx
git commit -m "feat(frontend): settings with preference summary, memory receipt, clear memory"
```

---

## Self-Review (run by the plan author, already done)

**Spec coverage:** §6/§15 trip revisit → `/app/trips` grid of cards linking to `/app/trip/{id}` (Tasks 2–3); §10 settings → preference summary + memory receipt from active `UserPreferenceFact`s + clear-memory (Tasks 4–5). Card fields are a condensed subset of §15's trip-overview vocabulary (destination/dates/status/budget) — no place-count/thumbnail because `listTrips` returns only `Trip[]` (no source). ✅

**Schema parity:** cards and settings render only real `Trip`/`TravelerProfile`/`UserPreferenceFact` fields; no invented `place_count`/`thumbnail`/`title`. ✅

**PRD-anchored copy:** "Using your saved travel preferences" (§10) and "Astrail learned:" (§10) are used verbatim; the receipt bullets are derived from the actual fixture facts (the PRD's example bullets are illustrative, not a required literal); clear-memory UI copy is authored (PRD dictates only the action). ✅

**Type consistency:** the four presenters are defined once (Task 1) and consumed by `TripCard`; `memoryReceiptLines` (Task 4) consumed by `SettingsView` (Task 5); `clearMemory` returns `{ ok: true }`; `getProfile` returns `{ profile, facts }`. No drift.

**Lifecycle:** `TripsList` and `SettingsView` both guard their fetch (and the clear action) with `activeRef` — the Plan 3/4 lesson.

**Placeholder scan:** every step has complete code, an exact command, and expected output. No TODO/TBD.

---

## Execution & Review Handoff

- **Executor:** Codex, task-by-task (TDD, one commit per task, verbatim transcription). If a test needs a mechanical fix (import path / `vi.mock` hoisting / `next/link` router context / accessible-name query), fix the *test mechanics* without weakening any assertion, and note it in the commit body. If you find a genuine spec/code bug in the plan, STOP before committing that task and report it rather than deviating silently.
- **Reviewer:** the planning agent (Opus) reviews each commit's diff for spec compliance, schema parity, seam purity, and non-vacuous tests, then runs a final whole-branch review + browser verification (load `/app/trips` and `/app/settings` with `NEXT_PUBLIC_MOCK_AUTH=true`: see the trip card, click into the trip, view the memory receipt, click Clear memory).
- **This is the last shell plan.** After Plan 5, the frontend shell (Plans 1–5) is complete: onboarding → create/generate → map trip view → trip list → settings, all walkable offline against the mock-api seam, ready to swap the seam for the real backend.
- **Out of scope (later / real-backend):** wiring the seam to Supabase/FastAPI; a real memory-clear mutation; trip-card thumbnails/place counts (need a bundle-level list endpoint); pagination.
