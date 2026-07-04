# Astrail Map-First Trip View Implementation Plan (Plan 2 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the hardcoded Tokyo trip bundle as a live, map-first trip view — a full-bleed Mapbox globe→city map with place pins and route lines, overlaid by a responsive panel (mobile bottom-sheet / desktop side-panel) containing the day selector, place cards, transport/restaurant/hotel strips, place-intel panel, and the agent decision timeline — all reading `getTrip('trip_tokyo_demo')`.

**Architecture:** A client `TripWorkspace` container fetches the `TripBundle` via the mock-api seam (`getTrip`), holds the shared UI state (`activeDayNumber`, `selectedPlaceId`), and composes a full-bleed `TripMap` plus a responsive overlay panel of presentational components. All data derivations (places-for-day, legs-for-day, place index) live in a pure, unit-tested `lib/trip/selectors.ts` so components stay dumb and DRY. The map is loaded via `next/dynamic({ ssr: false })` to avoid Mapbox touching `window` during SSR.

**Tech Stack:** Next.js 15.5 (App Router) · React 19.2 · TypeScript 5.9 · Tailwind CSS v4 (config-free, `@import "tailwindcss"`) · mapbox-gl 3.24 (raw, ships its own types) · Vitest 2 + @testing-library/react (jsdom).

## Global Constraints

- **Package manager:** npm. Run all commands from `C:\Github\astrail\frontend`.
- **Types:** Consume only the snake_case DB-shaped types from `@/lib/trip/backend-types`. Never introduce a camelCase trip shape. All fixture data comes through the mock-api seam; components never import fixtures except in tests.
- **Data seam:** Screens get data via `@/lib/trip/mock-api` (`getTrip(tripId): Promise<TripBundle | null>`). Do not import `@/lib/trip/fixtures` in component source — only in tests.
- **Styling:** Reuse the existing design tokens in `app/globals.css`. Colors via CSS vars through Tailwind arbitrary values: `bg-[var(--void)]`, `bg-[var(--deep)]`, `bg-[var(--elevated)]`, `text-[var(--starlight)]`, `text-[var(--muted)]`, `text-[var(--faint)]`, `text-[var(--brass)]`, `border-[var(--line)]`. Use the utility classes `.surface` (panel bg+border), `.type-display` (serif), `.type-body`, `.type-label` (mono). Brass `#C9974E` is the single accent.
- **Icons:** Inline SVG only. No icon library (STACK is frozen — no new deps).
- **No new dependencies.** mapbox-gl 3.24 is already installed and ships its own TypeScript declarations; do NOT add `@types/mapbox-gl` or `react-map-gl`.
- **Mapbox token:** Read `process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN` (exact name; already set in `frontend/.env.local`). Never reference `MAPBOX_ACCESS_TOKEN` or `MAPBOX_SECRET_TOKEN`.
- **Anti-hallucination (PRD §12):** Every rendered place shows its evidence — an `EvidenceChip` carrying confidence + source. Never render a place without surfacing its evidence.
- **Partial failure (PRD §17):** The view must degrade gracefully. A `no_route` transport leg shows a warning (not a broken line); a `skipped` hotel shows its skipped state, not an error. The fixture bakes exactly one of each.
- **Tests:** Vitest + @testing-library/react. Import fixture data with `import { TOKYO_TRIP } from '@/lib/trip/fixtures'`. In test files, import `describe, it, expect, vi` explicitly from `'vitest'` and `render, screen, fireEvent, waitFor` from `'@testing-library/react'`.
- **Client directive:** Any component with an event handler prop, a hook, or browser APIs starts with `'use client'`. Pure-render strips may omit it (they render inside the client tree).
- **Commits:** `feat(frontend): ...` / `test(frontend): ...`. One commit per task. The `.githooks/post-commit` SHIPLOG prompt auto-skips after 15s — let it.

---

## File Structure

- `lib/trip/selectors.ts` (new) — pure derivations over `TripBundle`. One responsibility: turn a bundle + selection into the slices each component needs.
- `lib/trip/__tests__/selectors.test.ts` (new) — unit tests for the above.
- `components/trip/EvidenceChip.tsx` (rewrite stub) — the shared evidence affordance.
- `components/trip/DaySelector.tsx` (rewrite stub) — day tabs.
- `components/trip/ItineraryCards.tsx` (rewrite stub) — place cards for the active day.
- `components/trip/TransportStrip.tsx` (rewrite stub) — transport legs for the active day.
- `components/trip/RestaurantStrip.tsx` (rewrite stub) — restaurant suggestions for the active day.
- `components/trip/HotelPanel.tsx` (new) — hotel suggestions (trip-level).
- `components/trip/PlaceIntelPanel.tsx` (rewrite stub) — detail for the selected place.
- `components/trip/OrchestratorSummary.tsx` (rewrite stub) — run stats header.
- `components/trip/AgentDecisionRail.tsx` (rewrite stub) — generation-event timeline.
- `components/map/TripMap.tsx` (rewrite stub) — Mapbox globe/pins/routes.
- `components/trip/TripWorkspace.tsx` (new) — the client orchestrator + responsive shell.
- `app/app/trip/[tripId]/page.tsx` (modify) — render `<TripWorkspace tripId={...} />`.
- Each component gets a sibling test under `components/trip/__tests__/` or `components/map/__tests__/`.

---

## Task 1: Trip selectors + EvidenceChip

**Files:**
- Create: `lib/trip/selectors.ts`
- Test: `lib/trip/__tests__/selectors.test.ts`
- Rewrite: `components/trip/EvidenceChip.tsx`
- Test: `components/trip/__tests__/EvidenceChip.test.tsx`

**Interfaces:**
- Consumes: `TripBundle`, `TripPlace`, `TripDay`, `TransportLeg`, `RestaurantSuggestion`, `HotelSuggestion`, `Place`, `TripPlaceEvidence` from `@/lib/trip/backend-types`.
- Produces (every later task relies on these exact signatures):
  - `orderedDays(bundle): TripDay[]`
  - `placesForDay(bundle, dayNumber: number): TripPlace[]`
  - `legsForDay(bundle, dayId: string): TransportLeg[]`
  - `restaurantsForDay(bundle, dayId: string): RestaurantSuggestion[]`
  - `tripHotels(bundle): HotelSuggestion[]`
  - `buildPlaceIndex(bundle): Map<string, Place>`
  - `findTripPlace(bundle, placeId: string | null): TripPlace | null`
  - `<EvidenceChip evidence={TripPlaceEvidence} />`

- [ ] **Step 1: Write the failing selectors test**

```ts
// lib/trip/__tests__/selectors.test.ts
import { describe, it, expect } from 'vitest'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import {
  orderedDays, placesForDay, legsForDay, restaurantsForDay,
  tripHotels, buildPlaceIndex, findTripPlace,
} from '@/lib/trip/selectors'

describe('trip selectors', () => {
  it('orderedDays returns days sorted by day_number', () => {
    const days = orderedDays(TOKYO_TRIP)
    expect(days.map((d) => d.day_number)).toEqual([1, 2, 3])
  })

  it('placesForDay returns only that day’s trip-places, sorted by sort_order', () => {
    const day1 = placesForDay(TOKYO_TRIP, 1)
    expect(day1.length).toBeGreaterThan(0)
    expect(day1.every((tp) => tp.day_number === 1)).toBe(true)
    const orders = day1.map((tp) => tp.sort_order ?? Infinity)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
  })

  it('legsForDay matches by trip_day_id and sorts by leg_order', () => {
    const legs = legsForDay(TOKYO_TRIP, 'day_1')
    expect(legs.every((l) => l.trip_day_id === 'day_1')).toBe(true)
  })

  it('restaurantsForDay filters by trip_day_id', () => {
    const rests = restaurantsForDay(TOKYO_TRIP, 'day_2')
    expect(rests.every((r) => r.trip_day_id === 'day_2')).toBe(true)
  })

  it('tripHotels returns the hotel rows', () => {
    expect(tripHotels(TOKYO_TRIP).length).toBeGreaterThan(0)
  })

  it('buildPlaceIndex maps every place_id to its Place', () => {
    const idx = buildPlaceIndex(TOKYO_TRIP)
    for (const tp of TOKYO_TRIP.places) {
      expect(idx.get(tp.place_id)?.id).toBe(tp.place_id)
    }
  })

  it('findTripPlace resolves a place_id and returns null for misses', () => {
    const known = TOKYO_TRIP.places[0].place_id
    expect(findTripPlace(TOKYO_TRIP, known)?.place_id).toBe(known)
    expect(findTripPlace(TOKYO_TRIP, 'nope')).toBeNull()
    expect(findTripPlace(TOKYO_TRIP, null)).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npm test -- selectors`
Expected: FAIL — cannot resolve `@/lib/trip/selectors`.

- [ ] **Step 3: Implement the selectors**

```ts
// lib/trip/selectors.ts
import type {
  TripBundle, TripPlace, TripDay, TransportLeg,
  RestaurantSuggestion, HotelSuggestion, Place,
} from './backend-types'

const bySortOrder = (a: TripPlace, b: TripPlace) =>
  (a.sort_order ?? Number.POSITIVE_INFINITY) - (b.sort_order ?? Number.POSITIVE_INFINITY)

export function orderedDays(bundle: TripBundle): TripDay[] {
  return [...bundle.days].sort((a, b) => a.day_number - b.day_number)
}

export function placesForDay(bundle: TripBundle, dayNumber: number): TripPlace[] {
  return bundle.places.filter((tp) => tp.day_number === dayNumber).sort(bySortOrder)
}

export function legsForDay(bundle: TripBundle, dayId: string): TransportLeg[] {
  return bundle.transport_legs
    .filter((l) => l.trip_day_id === dayId)
    .sort((a, b) => a.leg_order - b.leg_order)
}

export function restaurantsForDay(bundle: TripBundle, dayId: string): RestaurantSuggestion[] {
  return bundle.restaurants.filter((r) => r.trip_day_id === dayId)
}

export function tripHotels(bundle: TripBundle): HotelSuggestion[] {
  return bundle.hotels
}

export function buildPlaceIndex(bundle: TripBundle): Map<string, Place> {
  return new Map(bundle.places.map((tp) => [tp.place_id, tp.place]))
}

export function findTripPlace(bundle: TripBundle, placeId: string | null): TripPlace | null {
  if (!placeId) return null
  return bundle.places.find((tp) => tp.place_id === placeId) ?? null
}
```

- [ ] **Step 4: Run selectors test — confirm pass**

Run: `npm test -- selectors`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing EvidenceChip test**

```tsx
// components/trip/__tests__/EvidenceChip.test.tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import EvidenceChip from '@/components/trip/EvidenceChip'
import type { TripPlaceEvidence } from '@/lib/trip/backend-types'

const reel: TripPlaceEvidence = {
  confidence: 0.82, source_url: 'https://instagram.com/reel/abc',
  quote: 'the temple at dawn is unreal', rationale: null, evidence_kind: 'reel_quote',
}

describe('EvidenceChip', () => {
  it('shows confidence as a percentage and the kind label', () => {
    render(<EvidenceChip evidence={reel} />)
    expect(screen.getByText('82%')).toBeInTheDocument()
    expect(screen.getByText(/reel/i)).toBeInTheDocument()
  })

  it('links to the source when a url is present', () => {
    render(<EvidenceChip evidence={reel} />)
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', reel.source_url)
  })

  it('renders without a link when source_url is null', () => {
    render(<EvidenceChip evidence={{ ...reel, source_url: null }} />)
    expect(screen.queryByRole('link')).toBeNull()
  })
})
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `npm test -- EvidenceChip`
Expected: FAIL — the stub renders an empty `<div />`.

- [ ] **Step 7: Implement EvidenceChip**

```tsx
// components/trip/EvidenceChip.tsx
import type { TripPlaceEvidence, EvidenceKind } from '@/lib/trip/backend-types'

const KIND_LABEL: Record<EvidenceKind, string> = {
  reel_quote: 'Reel',
  requested_by_you: 'You',
  suggested_by_astrail: 'Astrail',
}

export default function EvidenceChip({ evidence }: { evidence: TripPlaceEvidence }) {
  const pct = `${Math.round(evidence.confidence * 100)}%`
  const label = KIND_LABEL[evidence.evidence_kind]
  return (
    <span className="type-label inline-flex items-center gap-1.5 rounded-full border border-[var(--line)] bg-[var(--brass-soft)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--brass)]">
      <span aria-hidden className="h-1 w-1 rounded-full bg-[var(--brass)]" />
      {label}
      <span className="text-[var(--muted)]">{pct}</span>
      {evidence.source_url ? (
        <a
          href={evidence.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-dotted underline-offset-2 hover:text-[var(--starlight)]"
        >
          source
        </a>
      ) : null}
    </span>
  )
}
```

- [ ] **Step 8: Run EvidenceChip test — confirm pass**

Run: `npm test -- EvidenceChip`
Expected: PASS (3 tests).

- [ ] **Step 9: Commit**

```bash
git add lib/trip/selectors.ts lib/trip/__tests__/selectors.test.ts components/trip/EvidenceChip.tsx components/trip/__tests__/EvidenceChip.test.tsx
git commit -m "feat(frontend): trip selectors + evidence chip"
```

---

## Task 2: DaySelector

**Files:**
- Rewrite: `components/trip/DaySelector.tsx`
- Test: `components/trip/__tests__/DaySelector.test.tsx`

**Interfaces:**
- Consumes: `TripDay` from `@/lib/trip/backend-types`.
- Produces: `<DaySelector days={TripDay[]} activeDayNumber={number} onSelect={(dayNumber:number)=>void} />`

- [ ] **Step 1: Write the failing test**

```tsx
// components/trip/__tests__/DaySelector.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import DaySelector from '@/components/trip/DaySelector'
import { orderedDays } from '@/lib/trip/selectors'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

const days = orderedDays(TOKYO_TRIP)

describe('DaySelector', () => {
  it('renders a button per day and marks the active one', () => {
    render(<DaySelector days={days} activeDayNumber={2} onSelect={() => {}} />)
    expect(screen.getAllByRole('button')).toHaveLength(days.length)
    expect(screen.getByRole('button', { name: /day 2/i })).toHaveAttribute('aria-pressed', 'true')
  })

  it('calls onSelect with the day number when a tab is clicked', () => {
    const onSelect = vi.fn()
    render(<DaySelector days={days} activeDayNumber={1} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: /day 3/i }))
    expect(onSelect).toHaveBeenCalledWith(3)
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm test -- DaySelector`
Expected: FAIL — stub renders empty.

- [ ] **Step 3: Implement DaySelector**

```tsx
// components/trip/DaySelector.tsx
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
                ? 'border-[var(--brass)] bg-[var(--brass-soft)] text-[var(--starlight)]'
                : 'border-[var(--line)] text-[var(--muted)] hover:text-[var(--starlight)]',
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
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npm test -- DaySelector`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add components/trip/DaySelector.tsx components/trip/__tests__/DaySelector.test.tsx
git commit -m "feat(frontend): day selector tabs"
```

---

## Task 3: ItineraryCards

**Files:**
- Rewrite: `components/trip/ItineraryCards.tsx`
- Test: `components/trip/__tests__/ItineraryCards.test.tsx`

**Interfaces:**
- Consumes: `TripPlace`, `PlaceSourceType` from `@/lib/trip/backend-types`; `EvidenceChip` from Task 1.
- Produces: `<ItineraryCards places={TripPlace[]} selectedPlaceId={string|null} onSelectPlace={(placeId:string)=>void} />`

- [ ] **Step 1: Write the failing test**

```tsx
// components/trip/__tests__/ItineraryCards.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ItineraryCards from '@/components/trip/ItineraryCards'
import { placesForDay } from '@/lib/trip/selectors'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

const day1 = placesForDay(TOKYO_TRIP, 1)

describe('ItineraryCards', () => {
  it('renders a card per place with its name and source badge', () => {
    render(<ItineraryCards places={day1} selectedPlaceId={null} onSelectPlace={() => {}} />)
    for (const tp of day1) {
      expect(screen.getByText(tp.place.name)).toBeInTheDocument()
    }
  })

  it('shows an evidence chip (confidence %) for every place', () => {
    render(<ItineraryCards places={day1} selectedPlaceId={null} onSelectPlace={() => {}} />)
    const pct = `${Math.round(day1[0].evidence_json.confidence * 100)}%`
    expect(screen.getAllByText(pct).length).toBeGreaterThan(0)
  })

  it('calls onSelectPlace with the place_id when a card is clicked', () => {
    const onSelectPlace = vi.fn()
    render(<ItineraryCards places={day1} selectedPlaceId={null} onSelectPlace={onSelectPlace} />)
    fireEvent.click(screen.getByText(day1[0].place.name))
    expect(onSelectPlace).toHaveBeenCalledWith(day1[0].place_id)
  })

  it('marks the selected card', () => {
    render(<ItineraryCards places={day1} selectedPlaceId={day1[0].place_id} onSelectPlace={() => {}} />)
    expect(screen.getByRole('button', { name: new RegExp(day1[0].place.name, 'i') }))
      .toHaveAttribute('aria-current', 'true')
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm test -- ItineraryCards`
Expected: FAIL — stub renders empty.

- [ ] **Step 3: Implement ItineraryCards**

```tsx
// components/trip/ItineraryCards.tsx
'use client'

import type { TripPlace, PlaceSourceType } from '@/lib/trip/backend-types'
import EvidenceChip from './EvidenceChip'

const SOURCE_BADGE: Record<PlaceSourceType, string> = {
  reel_extracted: 'From reel',
  user_requested: 'You asked',
  agent_suggested: 'Astrail pick',
}

export default function ItineraryCards({
  places, selectedPlaceId, onSelectPlace,
}: {
  places: TripPlace[]
  selectedPlaceId: string | null
  onSelectPlace: (placeId: string) => void
}) {
  if (places.length === 0) {
    return <p className="type-body text-sm text-[var(--muted)]">No stops planned for this day.</p>
  }
  return (
    <ol className="flex flex-col gap-2">
      {places.map((tp, i) => {
        const selected = tp.place_id === selectedPlaceId
        return (
          <li key={tp.id}>
            <button
              type="button"
              aria-current={selected ? 'true' : undefined}
              onClick={() => onSelectPlace(tp.place_id)}
              className={[
                'surface w-full rounded-xl p-3 text-left transition-colors',
                selected ? 'border-[var(--brass)]' : 'hover:border-[var(--brass)]',
              ].join(' ')}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <span className="type-label text-[10px] text-[var(--faint)]">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <h3 className="type-display truncate text-lg leading-tight text-[var(--starlight)]">
                    {tp.place.name}
                  </h3>
                  <p className="type-body text-xs text-[var(--muted)]">
                    {[tp.place.place_type, tp.place.area, tp.place.city].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <span className="type-label shrink-0 rounded border border-[var(--line)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--muted)]">
                  {SOURCE_BADGE[tp.source_type]}
                </span>
              </div>
              {tp.evidence_json.quote ? (
                <p className="type-body mt-2 border-l border-[var(--brass)] pl-2 text-xs italic text-[var(--muted)]">
                  “{tp.evidence_json.quote}”
                </p>
              ) : null}
              <div className="mt-2">
                <EvidenceChip evidence={tp.evidence_json} />
              </div>
            </button>
          </li>
        )
      })}
    </ol>
  )
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npm test -- ItineraryCards`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add components/trip/ItineraryCards.tsx components/trip/__tests__/ItineraryCards.test.tsx
git commit -m "feat(frontend): itinerary place cards with evidence"
```

---

## Task 4: TransportStrip + RestaurantStrip

**Files:**
- Rewrite: `components/trip/TransportStrip.tsx`
- Rewrite: `components/trip/RestaurantStrip.tsx`
- Test: `components/trip/__tests__/TransportStrip.test.tsx`
- Test: `components/trip/__tests__/RestaurantStrip.test.tsx`

**Interfaces:**
- Consumes: `TransportLeg`, `TransportStatus`, `RestaurantSuggestion`, `Place` from `@/lib/trip/backend-types`.
- Produces:
  - `<TransportStrip legs={TransportLeg[]} placeIndex={Map<string,Place>} />`
  - `<RestaurantStrip restaurants={RestaurantSuggestion[]} placeIndex={Map<string,Place>} />`

- [ ] **Step 1: Write the failing TransportStrip test**

```tsx
// components/trip/__tests__/TransportStrip.test.tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import TransportStrip from '@/components/trip/TransportStrip'
import { legsForDay, buildPlaceIndex } from '@/lib/trip/selectors'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

const idx = buildPlaceIndex(TOKYO_TRIP)

describe('TransportStrip', () => {
  it('renders each leg with from → to place names', () => {
    const legs = legsForDay(TOKYO_TRIP, 'day_1')
    render(<TransportStrip legs={legs} placeIndex={idx} />)
    const from = idx.get(legs[0].from_place_id!)!.name
    expect(screen.getByText(new RegExp(from, 'i'))).toBeInTheDocument()
  })

  it('surfaces the warning for a no_route leg instead of a duration', () => {
    const legs = legsForDay(TOKYO_TRIP, 'day_3') // baked no_route leg
    render(<TransportStrip legs={legs} placeIndex={idx} />)
    expect(screen.getByText(/no route|long transfer/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm test -- TransportStrip`
Expected: FAIL — stub renders empty.

- [ ] **Step 3: Implement TransportStrip**

```tsx
// components/trip/TransportStrip.tsx
import type { TransportLeg, TransportStatus, Place } from '@/lib/trip/backend-types'

const OK_STATUSES: TransportStatus[] = ['ok']

function fmtDuration(seconds: number | null): string {
  if (seconds == null) return ''
  const m = Math.round(seconds / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`
}

export default function TransportStrip({
  legs, placeIndex,
}: {
  legs: TransportLeg[]
  placeIndex: Map<string, Place>
}) {
  if (legs.length === 0) {
    return <p className="type-body text-xs text-[var(--muted)]">No transfers for this day.</p>
  }
  const name = (id: string | null) => (id ? placeIndex.get(id)?.name ?? 'Unknown' : 'Unknown')
  return (
    <ul className="flex flex-col gap-2">
      {legs.map((leg) => {
        const routed = OK_STATUSES.includes(leg.status)
        return (
          <li key={leg.id} className="surface rounded-lg p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="type-body truncate text-xs text-[var(--starlight)]">
                {name(leg.from_place_id)} <span className="text-[var(--faint)]">→</span> {name(leg.to_place_id)}
              </span>
              <span className="type-label shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                {leg.transport_mode.replace('_', ' ')}
              </span>
            </div>
            {routed ? (
              <p className="type-label mt-1 text-[11px] text-[var(--brass)]">
                {fmtDuration(leg.duration_seconds)}
                {leg.distance_meters != null ? ` · ${(leg.distance_meters / 1000).toFixed(1)} km` : ''}
              </p>
            ) : (
              <p className="type-body mt-1 text-[11px] text-[var(--muted)]">
                <span className="text-[var(--brass)]">No route.</span>{' '}
                {leg.warning ?? 'Routing unavailable for this leg.'}
              </p>
            )}
          </li>
        )
      })}
    </ul>
  )
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npm test -- TransportStrip`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing RestaurantStrip test**

```tsx
// components/trip/__tests__/RestaurantStrip.test.tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import RestaurantStrip from '@/components/trip/RestaurantStrip'
import { restaurantsForDay, buildPlaceIndex } from '@/lib/trip/selectors'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

const idx = buildPlaceIndex(TOKYO_TRIP)

describe('RestaurantStrip', () => {
  it('renders each restaurant with its summary', () => {
    const rests = restaurantsForDay(TOKYO_TRIP, 'day_2')
    render(<RestaurantStrip restaurants={rests} placeIndex={idx} />)
    expect(screen.getByText(new RegExp(rests[0].summary.slice(0, 12), 'i'))).toBeInTheDocument()
  })

  it('renders an empty-state when there are no restaurants', () => {
    render(<RestaurantStrip restaurants={[]} placeIndex={idx} />)
    expect(screen.getByText(/no restaurant/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 6: Run and confirm it fails**

Run: `npm test -- RestaurantStrip`
Expected: FAIL — stub renders empty.

- [ ] **Step 7: Implement RestaurantStrip**

```tsx
// components/trip/RestaurantStrip.tsx
import type { RestaurantSuggestion, Place } from '@/lib/trip/backend-types'

export default function RestaurantStrip({
  restaurants, placeIndex,
}: {
  restaurants: RestaurantSuggestion[]
  placeIndex: Map<string, Place>
}) {
  if (restaurants.length === 0) {
    return <p className="type-body text-xs text-[var(--muted)]">No restaurant picks for this day.</p>
  }
  return (
    <ul className="flex flex-col gap-2">
      {restaurants.map((r) => {
        const place = r.restaurant_place_id ? placeIndex.get(r.restaurant_place_id) : undefined
        return (
          <li key={r.id} className="surface rounded-lg p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="type-display truncate text-sm text-[var(--starlight)]">
                {place?.name ?? 'Suggested spot'}
              </span>
              {r.cuisine ? (
                <span className="type-label shrink-0 text-[10px] uppercase tracking-wide text-[var(--brass)]">
                  {r.cuisine}
                </span>
              ) : null}
            </div>
            <p className="type-body mt-1 text-xs text-[var(--muted)]">{r.summary}</p>
            {r.source_url ? (
              <a
                href={r.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="type-label text-[10px] text-[var(--brass)] underline decoration-dotted underline-offset-2"
              >
                evidence
              </a>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
```

- [ ] **Step 8: Run and confirm it passes**

Run: `npm test -- RestaurantStrip`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add components/trip/TransportStrip.tsx components/trip/RestaurantStrip.tsx components/trip/__tests__/TransportStrip.test.tsx components/trip/__tests__/RestaurantStrip.test.tsx
git commit -m "feat(frontend): transport + restaurant day strips with partial-failure handling"
```

---

## Task 5: HotelPanel + PlaceIntelPanel

**Files:**
- Create: `components/trip/HotelPanel.tsx`
- Rewrite: `components/trip/PlaceIntelPanel.tsx`
- Test: `components/trip/__tests__/HotelPanel.test.tsx`
- Test: `components/trip/__tests__/PlaceIntelPanel.test.tsx`

**Interfaces:**
- Consumes: `HotelSuggestion`, `HotelStatus`, `TripPlace` from `@/lib/trip/backend-types`; `EvidenceChip` from Task 1.
- Produces:
  - `<HotelPanel hotels={HotelSuggestion[]} />`
  - `<PlaceIntelPanel tripPlace={TripPlace | null} />`

- [ ] **Step 1: Write the failing HotelPanel test**

```tsx
// components/trip/__tests__/HotelPanel.test.tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import HotelPanel from '@/components/trip/HotelPanel'
import { tripHotels } from '@/lib/trip/selectors'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

describe('HotelPanel', () => {
  it('renders each hotel name', () => {
    render(<HotelPanel hotels={tripHotels(TOKYO_TRIP)} />)
    expect(screen.getByText(tripHotels(TOKYO_TRIP)[0].name)).toBeInTheDocument()
  })

  it('shows a skipped state for a skipped hotel', () => {
    const skipped = tripHotels(TOKYO_TRIP).find((h) => h.status === 'skipped')!
    render(<HotelPanel hotels={[skipped]} />)
    expect(screen.getByText(/skipped/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm test -- HotelPanel`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement HotelPanel**

```tsx
// components/trip/HotelPanel.tsx
import type { HotelSuggestion, HotelStatus } from '@/lib/trip/backend-types'

const STATUS_LABEL: Record<HotelStatus, string> = {
  suggested: 'Suggested',
  unavailable: 'Unavailable',
  skipped: 'Skipped',
  failed: 'Search failed',
}

export default function HotelPanel({ hotels }: { hotels: HotelSuggestion[] }) {
  if (hotels.length === 0) {
    return <p className="type-body text-xs text-[var(--muted)]">No lodging suggestions yet.</p>
  }
  return (
    <ul className="flex flex-col gap-2">
      {hotels.map((h) => {
        const inactive = h.status !== 'suggested'
        return (
          <li key={h.id} className={['surface rounded-lg p-2.5', inactive ? 'opacity-60' : ''].join(' ')}>
            <div className="flex items-center justify-between gap-2">
              <span className="type-display truncate text-sm text-[var(--starlight)]">{h.name}</span>
              <span className="type-label shrink-0 text-[10px] uppercase tracking-wide text-[var(--muted)]">
                {STATUS_LABEL[h.status]}
              </span>
            </div>
            <p className="type-body mt-1 text-xs text-[var(--muted)]">
              {[h.area, h.star_rating ? `${h.star_rating}★` : null].filter(Boolean).join(' · ')}
            </p>
          </li>
        )
      })}
    </ul>
  )
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npm test -- HotelPanel`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing PlaceIntelPanel test**

```tsx
// components/trip/__tests__/PlaceIntelPanel.test.tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import PlaceIntelPanel from '@/components/trip/PlaceIntelPanel'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

describe('PlaceIntelPanel', () => {
  it('prompts to select a place when none is selected', () => {
    render(<PlaceIntelPanel tripPlace={null} />)
    expect(screen.getByText(/select a place/i)).toBeInTheDocument()
  })

  it('shows the selected place name, location, and evidence', () => {
    const tp = TOKYO_TRIP.places[0]
    render(<PlaceIntelPanel tripPlace={tp} />)
    expect(screen.getByRole('heading', { name: new RegExp(tp.place.name, 'i') })).toBeInTheDocument()
    const pct = `${Math.round(tp.evidence_json.confidence * 100)}%`
    expect(screen.getByText(pct)).toBeInTheDocument()
  })
})
```

- [ ] **Step 6: Run and confirm it fails**

Run: `npm test -- PlaceIntelPanel`
Expected: FAIL — stub renders empty.

- [ ] **Step 7: Implement PlaceIntelPanel**

```tsx
// components/trip/PlaceIntelPanel.tsx
import type { TripPlace } from '@/lib/trip/backend-types'
import EvidenceChip from './EvidenceChip'

export default function PlaceIntelPanel({ tripPlace }: { tripPlace: TripPlace | null }) {
  if (!tripPlace) {
    return (
      <div className="surface rounded-xl p-4">
        <p className="type-body text-sm text-[var(--muted)]">Select a place to see its evidence.</p>
      </div>
    )
  }
  const { place, evidence_json: ev } = tripPlace
  return (
    <div className="surface rounded-xl p-4">
      <span className="type-label text-[10px] uppercase tracking-wide text-[var(--faint)]">{place.place_type}</span>
      <h3 className="type-display text-xl leading-tight text-[var(--starlight)]">{place.name}</h3>
      <p className="type-body text-xs text-[var(--muted)]">
        {[place.area, place.city, place.country].filter(Boolean).join(', ')}
      </p>
      {ev.quote ? (
        <p className="type-body mt-3 border-l border-[var(--brass)] pl-3 text-sm italic text-[var(--muted)]">
          “{ev.quote}”
        </p>
      ) : null}
      {ev.rationale ? (
        <p className="type-body mt-3 text-sm text-[var(--muted)]">{ev.rationale}</p>
      ) : null}
      <div className="mt-3">
        <EvidenceChip evidence={ev} />
      </div>
    </div>
  )
}
```

- [ ] **Step 8: Run and confirm it passes**

Run: `npm test -- PlaceIntelPanel`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add components/trip/HotelPanel.tsx components/trip/PlaceIntelPanel.tsx components/trip/__tests__/HotelPanel.test.tsx components/trip/__tests__/PlaceIntelPanel.test.tsx
git commit -m "feat(frontend): hotel panel + place intel panel"
```

---

## Task 6: OrchestratorSummary + AgentDecisionRail

**Files:**
- Rewrite: `components/trip/OrchestratorSummary.tsx`
- Rewrite: `components/trip/AgentDecisionRail.tsx`
- Test: `components/trip/__tests__/OrchestratorSummary.test.tsx`
- Test: `components/trip/__tests__/AgentDecisionRail.test.tsx`

**Interfaces:**
- Consumes: `TripBundle`, `GenerationEvent`, `GenerationEventType` from `@/lib/trip/backend-types`.
- Produces:
  - `<OrchestratorSummary bundle={TripBundle} />`
  - `<AgentDecisionRail events={GenerationEvent[]} />`

- [ ] **Step 1: Write the failing OrchestratorSummary test**

```tsx
// components/trip/__tests__/OrchestratorSummary.test.tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import OrchestratorSummary from '@/components/trip/OrchestratorSummary'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

describe('OrchestratorSummary', () => {
  it('shows place and day counts', () => {
    render(<OrchestratorSummary bundle={TOKYO_TRIP} />)
    expect(screen.getByText(String(TOKYO_TRIP.places.length))).toBeInTheDocument()
    expect(screen.getByText(String(TOKYO_TRIP.days.length))).toBeInTheDocument()
  })

  it('flags saved_with_gaps status', () => {
    render(<OrchestratorSummary bundle={TOKYO_TRIP} />)
    expect(screen.getByText(/gaps/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm test -- OrchestratorSummary`
Expected: FAIL — stub renders empty.

- [ ] **Step 3: Implement OrchestratorSummary**

```tsx
// components/trip/OrchestratorSummary.tsx
import type { TripBundle } from '@/lib/trip/backend-types'

function Stat({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="flex flex-col">
      <span className="type-display text-2xl leading-none text-[var(--starlight)]">{value}</span>
      <span className="type-label text-[10px] uppercase tracking-wide text-[var(--faint)]">{label}</span>
    </div>
  )
}

export default function OrchestratorSummary({ bundle }: { bundle: TripBundle }) {
  const withGaps = bundle.trip.status === 'saved_with_gaps'
  return (
    <div className="surface rounded-xl p-4">
      <div className="flex items-center justify-between">
        <h2 className="type-display text-lg text-[var(--starlight)]">{bundle.trip.title ?? 'Your trip'}</h2>
        {withGaps ? (
          <span className="type-label rounded-full border border-[var(--brass)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--brass)]">
            Saved with gaps
          </span>
        ) : null}
      </div>
      <div className="mt-3 grid grid-cols-4 gap-2">
        <Stat value={bundle.places.length} label="places" />
        <Stat value={bundle.days.length} label="days" />
        <Stat value={bundle.transport_legs.length} label="legs" />
        <Stat value={bundle.inspiration.length} label="sources" />
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npm test -- OrchestratorSummary`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing AgentDecisionRail test**

```tsx
// components/trip/__tests__/AgentDecisionRail.test.tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import AgentDecisionRail from '@/components/trip/AgentDecisionRail'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

describe('AgentDecisionRail', () => {
  it('renders a row per generation event with its message', () => {
    render(<AgentDecisionRail events={TOKYO_TRIP.events} />)
    expect(screen.getByText(TOKYO_TRIP.events[0].message)).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(TOKYO_TRIP.events.length)
  })

  it('visually distinguishes warning events', () => {
    const warning = TOKYO_TRIP.events.find((e) => e.event_type === 'warning')!
    render(<AgentDecisionRail events={[warning]} />)
    expect(screen.getByText(warning.message)).toBeInTheDocument()
    expect(screen.getByText(/warning/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 6: Run and confirm it fails**

Run: `npm test -- AgentDecisionRail`
Expected: FAIL — stub renders `null`.

- [ ] **Step 7: Implement AgentDecisionRail**

```tsx
// components/trip/AgentDecisionRail.tsx
import type { GenerationEvent, GenerationEventType } from '@/lib/trip/backend-types'

const DOT_COLOR: Record<GenerationEventType, string> = {
  stage: 'var(--faint)',
  decision: 'var(--brass)',
  warning: 'var(--starlight)',
}

export default function AgentDecisionRail({ events }: { events: GenerationEvent[] }) {
  if (events.length === 0) {
    return <p className="type-body text-xs text-[var(--muted)]">No agent activity recorded.</p>
  }
  return (
    <ol className="flex flex-col">
      {events.map((ev) => (
        <li key={ev.id} className="relative flex gap-3 pb-3 last:pb-0">
          <span
            aria-hidden
            className="mt-1 h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: DOT_COLOR[ev.event_type] }}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="type-label text-[10px] uppercase tracking-wide text-[var(--faint)]">{ev.stage}</span>
              {ev.event_type === 'warning' ? (
                <span className="type-label text-[9px] uppercase tracking-wide text-[var(--brass)]">warning</span>
              ) : null}
            </div>
            <p className="type-body text-xs text-[var(--muted)]">{ev.message}</p>
          </div>
        </li>
      ))}
    </ol>
  )
}
```

- [ ] **Step 8: Run and confirm it passes**

Run: `npm test -- AgentDecisionRail`
Expected: PASS (2 tests).

- [ ] **Step 9: Commit**

```bash
git add components/trip/OrchestratorSummary.tsx components/trip/AgentDecisionRail.tsx components/trip/__tests__/OrchestratorSummary.test.tsx components/trip/__tests__/AgentDecisionRail.test.tsx
git commit -m "feat(frontend): orchestrator summary + agent decision rail"
```

---

## Task 7: TripMap (Mapbox globe, pins, routes)

**Files:**
- Rewrite: `components/map/TripMap.tsx`
- Test: `components/map/__tests__/TripMap.test.tsx`

**Interfaces:**
- Consumes: `TripBundle`, `PlaceSourceType` from `@/lib/trip/backend-types`; `orderedDays`, `placesForDay`, `legsForDay`, `buildPlaceIndex` from `@/lib/trip/selectors`.
- Produces: `<TripMap bundle={TripBundle} activeDayNumber={number} selectedPlaceId={string|null} onSelectPlace={(placeId:string)=>void} />` (default export).

**Notes for the implementer:**
- mapbox-gl 3.24 ships its own TypeScript types — do NOT add `@types/mapbox-gl`.
- Import the Mapbox CSS at the top of this file: `import 'mapbox-gl/dist/mapbox-gl.css'`.
- This component is rendered client-only (Task 8 loads it via `next/dynamic({ ssr:false })`), so a top-level `import mapboxgl from 'mapbox-gl'` is safe. It still declares `'use client'`.
- The map/GL layer is NOT unit-tested against real WebGL (jsdom has none). The test mocks `mapbox-gl` and asserts: (a) with a token, the map is constructed; (b) without a token, a fallback renders and the map is not constructed. Deeper behavior is verified in the browser (Task 8 handoff).
- Guard React StrictMode double-effect with a ref so only one map is created.

- [ ] **Step 1: Write the failing test**

```tsx
// components/map/__tests__/TripMap.test.tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

const mapInstance = {
  on: vi.fn((evt: string, cb: () => void) => { if (evt === 'load') cb() }),
  addSource: vi.fn(), addLayer: vi.fn(),
  getSource: vi.fn(() => undefined), getLayer: vi.fn(() => undefined),
  removeLayer: vi.fn(), removeSource: vi.fn(),
  flyTo: vi.fn(), fitBounds: vi.fn(), setConfigProperty: vi.fn(), remove: vi.fn(),
}
const MapCtor = vi.fn(() => mapInstance)
const MarkerCtor = vi.fn(() => ({
  setLngLat: vi.fn().mockReturnThis(), addTo: vi.fn().mockReturnThis(), remove: vi.fn(),
}))
const BoundsCtor = vi.fn(() => ({ extend: vi.fn() }))

vi.mock('mapbox-gl', () => ({
  default: { Map: MapCtor, Marker: MarkerCtor, LngLatBounds: BoundsCtor, accessToken: '' },
}))
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}))

import TripMap from '@/components/map/TripMap'

describe('TripMap', () => {
  beforeEach(() => { MapCtor.mockClear() })
  afterEach(() => { delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN })

  it('constructs a Mapbox map when a token is present', () => {
    process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN = 'pk.test'
    render(<TripMap bundle={TOKYO_TRIP} activeDayNumber={1} selectedPlaceId={null} onSelectPlace={() => {}} />)
    expect(MapCtor).toHaveBeenCalledTimes(1)
  })

  it('shows a fallback and does not construct a map without a token', () => {
    render(<TripMap bundle={TOKYO_TRIP} activeDayNumber={1} selectedPlaceId={null} onSelectPlace={() => {}} />)
    expect(screen.getByText(/map unavailable/i)).toBeInTheDocument()
    expect(MapCtor).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm test -- TripMap`
Expected: FAIL — the stub renders an empty `<div />`; neither assertion holds.

- [ ] **Step 3: Implement TripMap**

```tsx
// components/map/TripMap.tsx
'use client'

import { useEffect, useRef } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import type { TripBundle, PlaceSourceType } from '@/lib/trip/backend-types'
import { placesForDay, legsForDay, orderedDays, buildPlaceIndex } from '@/lib/trip/selectors'

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN

const PIN_COLOR: Record<PlaceSourceType, string> = {
  reel_extracted: '#C9974E',
  user_requested: '#F2ECE0',
  agent_suggested: '#8FB4C9',
}

export default function TripMap({
  bundle, activeDayNumber, selectedPlaceId, onSelectPlace,
}: {
  bundle: TripBundle
  activeDayNumber: number
  selectedPlaceId: string | null
  onSelectPlace: (placeId: string) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const markersRef = useRef<mapboxgl.Marker[]>([])
  const routeIdsRef = useRef<string[]>([])
  const loadedRef = useRef(false)

  // Create the map once.
  useEffect(() => {
    if (!TOKEN || !containerRef.current || mapRef.current) return
    mapboxgl.accessToken = TOKEN
    const first = bundle.places[0]?.place
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/standard',
      projection: 'globe',
      center: first ? [first.lng, first.lat] : [0, 20],
      zoom: 1.4,
      pitch: 0,
    })
    mapRef.current = map
    map.on('load', () => {
      loadedRef.current = true
      // Standard style (v3): dark cosmic look via the night light preset; globe renders its own atmosphere.
      map.setConfigProperty('basemap', 'lightPreset', 'night')
      drawMarkers()
      drawRoutes()
      flyToTrip()
    })
    return () => {
      map.remove()
      mapRef.current = null
      loadedRef.current = false
      markersRef.current = []
      routeIdsRef.current = []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function drawMarkers() {
    const map = mapRef.current
    if (!map) return
    markersRef.current.forEach((m) => m.remove())
    markersRef.current = []
    for (const tp of bundle.places) {
      const el = document.createElement('button')
      el.type = 'button'
      el.setAttribute('aria-label', tp.place.name)
      el.style.cssText =
        `width:14px;height:14px;border-radius:9999px;border:2px solid #050506;cursor:pointer;` +
        `background:${PIN_COLOR[tp.source_type]};box-shadow:0 0 0 1px rgba(242,236,224,0.3)`
      el.addEventListener('click', (e) => { e.stopPropagation(); onSelectPlace(tp.place_id) })
      const marker = new mapboxgl.Marker({ element: el }).setLngLat([tp.place.lng, tp.place.lat]).addTo(map)
      markersRef.current.push(marker)
    }
  }

  function clearRoutes() {
    const map = mapRef.current
    if (!map) return
    for (const id of routeIdsRef.current) {
      if (map.getLayer(id)) map.removeLayer(id)
      if (map.getSource(id)) map.removeSource(id)
    }
    routeIdsRef.current = []
  }

  function drawRoutes() {
    const map = mapRef.current
    if (!map || !loadedRef.current) return
    clearRoutes()
    const day = orderedDays(bundle).find((d) => d.day_number === activeDayNumber)
    if (!day) return
    for (const leg of legsForDay(bundle, day.id)) {
      if (leg.status !== 'ok' || !leg.route_geometry) continue // skip no_route/failed legs
      const id = `route-${leg.id}`
      map.addSource(id, {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: leg.route_geometry },
      })
      map.addLayer({
        id,
        type: 'line',
        source: id,
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#C9974E', 'line-width': 3, 'line-opacity': 0.85 },
      })
      routeIdsRef.current.push(id)
    }
  }

  function flyToTrip() {
    const map = mapRef.current
    if (!map) return
    const pts = bundle.places.map((tp) => [tp.place.lng, tp.place.lat] as [number, number])
    if (pts.length === 0) return
    const bounds = new mapboxgl.LngLatBounds()
    pts.forEach((p) => bounds.extend(p))
    map.fitBounds(bounds, { padding: 80, maxZoom: 13, pitch: 45, duration: 2200 })
  }

  // Redraw routes when the active day changes.
  useEffect(() => {
    if (loadedRef.current) drawRoutes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDayNumber])

  // Fly to the selected place.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !selectedPlaceId) return
    const idx = buildPlaceIndex(bundle)
    const place = idx.get(selectedPlaceId)
    if (place) map.flyTo({ center: [place.lng, place.lat], zoom: 14, pitch: 55, duration: 1400, essential: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPlaceId])

  if (!TOKEN) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[var(--deep)]">
        <p className="type-label text-xs uppercase tracking-wide text-[var(--muted)]">Map unavailable — token missing</p>
      </div>
    )
  }
  return <div ref={containerRef} data-testid="trip-map" className="h-full w-full" />
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npm test -- TripMap`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck (Mapbox types are load-bearing here)**

Run: `npm run typecheck`
Expected: exit 0. If `route_geometry` triggers a GeoJSON type complaint, confirm the import `import type { TripBundle } from '@/lib/trip/backend-types'` resolves `GeoJSON.LineString` (the backend-types file references the global `GeoJSON` namespace). No new types should be needed.

- [ ] **Step 6: Commit**

```bash
git add components/map/TripMap.tsx components/map/__tests__/TripMap.test.tsx
git commit -m "feat(frontend): mapbox globe trip map with pins + route layers"
```

---

## Task 8: TripWorkspace + wire the trip page (responsive shell)

**Files:**
- Create: `components/trip/TripWorkspace.tsx`
- Modify: `app/app/trip/[tripId]/page.tsx`
- Test: `components/trip/__tests__/TripWorkspace.test.tsx`

**Interfaces:**
- Consumes: everything above; `getTrip` from `@/lib/trip/mock-api`; `orderedDays`, `placesForDay`, `legsForDay`, `restaurantsForDay`, `tripHotels`, `buildPlaceIndex`, `findTripPlace` from `@/lib/trip/selectors`.
- Produces: `<TripWorkspace tripId={string} />` (default export). The trip page renders it.

**Notes for the implementer:**
- `TripMap` is loaded via `next/dynamic(() => import('@/components/map/TripMap'), { ssr: false })` so Mapbox never runs during SSR.
- The panel is a single element that is a **bottom-sheet on mobile** (two heights: peek ~42dvh / expanded ~82dvh, toggled by a handle button) and a **fixed left side-panel on desktop** (`md:` full-height, 440px wide). One content set, two shells.
- In the test, mock the `TripMap` module (avoid Mapbox) and use the real `getTrip` mock (350ms latency) with `findBy*`/`waitFor`.

- [ ] **Step 1: Write the failing test**

```tsx
// components/trip/__tests__/TripWorkspace.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import TripWorkspace from '@/components/trip/TripWorkspace'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import { placesForDay } from '@/lib/trip/selectors'

vi.mock('@/components/map/TripMap', () => ({ default: () => <div data-testid="trip-map" /> }))

describe('TripWorkspace', () => {
  it('loads the trip and renders day-1 places', async () => {
    render(<TripWorkspace tripId={TOKYO_TRIP.trip.id} />)
    const firstDay1Place = placesForDay(TOKYO_TRIP, 1)[0].place.name
    expect(await screen.findByText(firstDay1Place)).toBeInTheDocument()
    expect(screen.getByTestId('trip-map')).toBeInTheDocument()
  })

  it('switching days swaps the visible places', async () => {
    render(<TripWorkspace tripId={TOKYO_TRIP.trip.id} />)
    const day3Place = placesForDay(TOKYO_TRIP, 3)[0].place.name
    // wait for load
    await screen.findByRole('tab', { name: /day 3/i })
    fireEvent.click(screen.getByRole('tab', { name: /day 3/i }))
    await waitFor(() => expect(screen.getByText(day3Place)).toBeInTheDocument())
  })

  it('shows a not-found state for an unknown trip id', async () => {
    render(<TripWorkspace tripId="does_not_exist" />)
    expect(await screen.findByText(/not found/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npm test -- TripWorkspace`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement TripWorkspace**

```tsx
// components/trip/TripWorkspace.tsx
'use client'

import { useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import type { TripBundle } from '@/lib/trip/backend-types'
import { getTrip } from '@/lib/trip/mock-api'
import {
  orderedDays, placesForDay, legsForDay, restaurantsForDay,
  tripHotels, buildPlaceIndex, findTripPlace,
} from '@/lib/trip/selectors'
import DaySelector from './DaySelector'
import ItineraryCards from './ItineraryCards'
import TransportStrip from './TransportStrip'
import RestaurantStrip from './RestaurantStrip'
import HotelPanel from './HotelPanel'
import PlaceIntelPanel from './PlaceIntelPanel'
import OrchestratorSummary from './OrchestratorSummary'
import AgentDecisionRail from './AgentDecisionRail'

const TripMap = dynamic(() => import('@/components/map/TripMap'), { ssr: false })

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="type-label mb-2 text-[11px] uppercase tracking-wide text-[var(--faint)]">{title}</h3>
      {children}
    </section>
  )
}

export default function TripWorkspace({ tripId }: { tripId: string }) {
  const [bundle, setBundle] = useState<TripBundle | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'not_found'>('loading')
  const [activeDayNumber, setActiveDayNumber] = useState(1)
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let active = true
    setStatus('loading')
    getTrip(tripId).then((b) => {
      if (!active) return
      if (!b) { setStatus('not_found'); return }
      setBundle(b)
      setActiveDayNumber(orderedDays(b)[0]?.day_number ?? 1)
      setStatus('ready')
    })
    return () => { active = false }
  }, [tripId])

  const days = useMemo(() => (bundle ? orderedDays(bundle) : []), [bundle])
  const placeIndex = useMemo(() => (bundle ? buildPlaceIndex(bundle) : new Map()), [bundle])
  const activeDay = days.find((d) => d.day_number === activeDayNumber) ?? null
  const dayPlaces = bundle ? placesForDay(bundle, activeDayNumber) : []
  const dayLegs = bundle && activeDay ? legsForDay(bundle, activeDay.id) : []
  const dayRestaurants = bundle && activeDay ? restaurantsForDay(bundle, activeDay.id) : []
  const selectedTripPlace = bundle ? findTripPlace(bundle, selectedPlaceId) : null

  if (status === 'loading') {
    return (
      <main className="flex h-[100dvh] items-center justify-center bg-[var(--void)]">
        <p className="type-label text-xs uppercase tracking-wide text-[var(--muted)]">Loading trip…</p>
      </main>
    )
  }
  if (status === 'not_found' || !bundle) {
    return (
      <main className="flex h-[100dvh] items-center justify-center bg-[var(--void)]">
        <p className="type-body text-sm text-[var(--muted)]">Trip not found.</p>
      </main>
    )
  }

  return (
    <main className="relative h-[100dvh] w-full overflow-hidden bg-[var(--void)]">
      <div className="absolute inset-0">
        <TripMap
          bundle={bundle}
          activeDayNumber={activeDayNumber}
          selectedPlaceId={selectedPlaceId}
          onSelectPlace={(id) => { setSelectedPlaceId(id); setExpanded(true) }}
        />
      </div>

      <aside
        className={[
          'absolute z-10 overflow-y-auto surface backdrop-blur-sm',
          'inset-x-0 bottom-0 rounded-t-2xl transition-[height] duration-300 ease-out',
          expanded ? 'h-[82dvh]' : 'h-[42dvh]',
          'md:inset-y-0 md:left-0 md:right-auto md:h-full md:w-[440px] md:rounded-none md:rounded-r-2xl',
        ].join(' ')}
        aria-label="Trip details"
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mx-auto mt-2 mb-1 block h-1.5 w-10 rounded-full bg-[var(--line)] md:hidden"
          aria-label={expanded ? 'Collapse panel' : 'Expand panel'}
        />
        <div className="p-4">
          <OrchestratorSummary bundle={bundle} />

          <Section title="Days">
            <DaySelector days={days} activeDayNumber={activeDayNumber} onSelect={setActiveDayNumber} />
          </Section>

          <Section title="Itinerary">
            <ItineraryCards places={dayPlaces} selectedPlaceId={selectedPlaceId} onSelectPlace={setSelectedPlaceId} />
          </Section>

          <Section title="Getting around">
            <TransportStrip legs={dayLegs} placeIndex={placeIndex} />
          </Section>

          <Section title="Where to eat">
            <RestaurantStrip restaurants={dayRestaurants} placeIndex={placeIndex} />
          </Section>

          <Section title="Where to stay">
            <HotelPanel hotels={tripHotels(bundle)} />
          </Section>

          <Section title="Place detail">
            <PlaceIntelPanel tripPlace={selectedTripPlace} />
          </Section>

          <Section title="How Astrail built this">
            <AgentDecisionRail events={bundle.events} />
          </Section>
        </div>
      </aside>
    </main>
  )
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npm test -- TripWorkspace`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the trip page**

```tsx
// app/app/trip/[tripId]/page.tsx
import TripWorkspace from '@/components/trip/TripWorkspace'

export default async function TripPage({ params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params
  return <TripWorkspace tripId={tripId} />
}
```

- [ ] **Step 6: Full suite + typecheck**

Run: `npm test`
Expected: ALL pass (Plan 1 tests + all Task 1–8 tests).

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add components/trip/TripWorkspace.tsx components/trip/__tests__/TripWorkspace.test.tsx app/app/trip/[tripId]/page.tsx
git commit -m "feat(frontend): trip workspace shell wiring the map trip view"
```

- [ ] **Step 8: Browser verification (manual handoff — Mapbox needs a real GL context)**

Run: `npm run dev` (ensure `frontend/.env.local` has `NEXT_PUBLIC_MOCK_AUTH=true` and `NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN`).
Visit `http://localhost:3000/app/trip/trip_tokyo_demo` and confirm:
- The globe renders and flies into Tokyo with pins at the 6 places.
- Day tabs switch the visible route line(s); day 3's Shibuya→Disney leg draws NO line and the strip shows the "No route" warning.
- Clicking a pin selects it, flies to it, and fills the place-intel panel.
- On a narrow viewport, the bottom sheet peeks and expands via the handle; on desktop the left panel is fixed.
Report this as a manual check (not an automated test).

---

## Self-Review

**1. Spec coverage** (Plan 2 scope from the foundation roadmap: "`TripMap.tsx` (Mapbox GL globe→city fly-to, pins, route layers), bottom-sheet/side-panel shell, place cards, day selector, place intel panel, restaurant/transport/hotel strips, agent decision timeline, evidence chips. Reads `getTrip('trip_tokyo_demo')`."):
- TripMap globe→city fly-to + pins + route layers → Task 7. ✅
- bottom-sheet/side-panel responsive shell → Task 8. ✅
- place cards → Task 3. ✅
- day selector → Task 2. ✅
- place intel panel → Task 5. ✅
- restaurant/transport/hotel strips → Tasks 4 (transport+restaurant) & 5 (hotel). ✅
- agent decision timeline → Task 6 (AgentDecisionRail + OrchestratorSummary). ✅
- evidence chips → Task 1 (EvidenceChip), used in Tasks 3 & 5. ✅
- Reads `getTrip('trip_tokyo_demo')` → Task 8 (`getTrip(tripId)` with the page passing the route param). ✅

**2. Placeholder scan:** No `TODO`/`TBD`/"add error handling"/"similar to" placeholders. The only `eslint-disable-next-line react-hooks/exhaustive-deps` comments are deliberate (the effects intentionally run on a subset of deps; the map lifecycle is manual). Every code step shows complete code.

**3. Type consistency:** Selector names are identical across the plan (`orderedDays`, `placesForDay`, `legsForDay`, `restaurantsForDay`, `tripHotels`, `buildPlaceIndex`, `findTripPlace`). Component prop names match between their defining task and their use in Task 8 (`days`/`activeDayNumber`/`onSelect`; `places`/`selectedPlaceId`/`onSelectPlace`; `legs`/`placeIndex`; `restaurants`/`placeIndex`; `hotels`; `tripPlace`; `events`; `bundle`). `TripMap` props (`bundle`, `activeDayNumber`, `selectedPlaceId`, `onSelectPlace`) match Task 8's usage. All types are the snake_case shapes from `@/lib/trip/backend-types`.

**Out of scope (later plans):** Inspiration tray + generation stream (Plan 3), onboarding (Plan 4), trip list + settings (Plan 5), swapping `mock-api` for the real backend.

**Testing caveat (honest):** The Mapbox GL rendering itself is not exercised in jsdom; Task 7's test mocks `mapbox-gl` and asserts construction + the token guard. Real map behavior (globe, fly-to, line layers, pin clicks) is verified in the browser at Task 8 Step 8. Every other component is fully unit-tested against the fixture.
