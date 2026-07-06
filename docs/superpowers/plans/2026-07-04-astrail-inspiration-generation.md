# Astrail Inspiration Tray + Trip Brief + Generation Implementation Plan (Plan 3 of 5)

> **For the executing engineer (Codex):** You have **zero prior context** for this codebase. Everything you need is in this document — exact file paths, complete code, exact commands, and expected output. Implement task-by-task in order. Each task is TDD: write the failing test, run it (see it fail), transcribe the implementation **verbatim**, run it (see it pass), then commit. Do not skip the "run to verify it fails" step. Do not add dependencies. Do not import anything from `legacy/`.
>
> If a test fails for a purely **mechanical** reason (an import path, a Vitest `vi.mock` hoisting error, an accessible-role query that doesn't match the component's real role), fix the *test mechanics* — never weaken an assertion to make it pass. If an assertion genuinely can't pass, stop and report; do not delete or loosen it.

**Goal:** Build the "create a trip" flow at `/app` — an Inspiration Tray (paste Instagram Reel URLs + add requested places → live inspiration cards), a Trip Brief form (optional dates/budget/origin/preferences), and a Generation phase (scripted SSE timeline) that routes to the trip view when the run completes — all reading the mock-api seam, fully offline and deterministic.

**Architecture:** A client `CreateTripFlow` orchestrator holds the draft inspiration items + brief form state and a two-phase state machine (`compose` → `generating`). Pure parsing/derivation lives in a unit-tested `lib/trip/parse-inspiration.ts` (URL normalization, dedup, cap, request assembly) so the components stay dumb. On "Generate," the orchestrator calls the mock seam `createTrip(request)` to get a `trip_id`, then `streamGeneration(trip_id, onEvent)` to drive a live `GenerationProgress` timeline; the terminal `result` event routes to `/app/trip/{trip_id}`.

**Tech Stack:** Next.js 15.5 (App Router) · React 19.2 · TypeScript 5.9 · Tailwind CSS v4 (config-free, `@import "tailwindcss"`) · Vitest 2 + @testing-library/react (jsdom). No new dependencies.

## Global Constraints

- **Package manager:** npm. Run **every** command from `C:\Github\astrail\frontend` (the Next.js app root). On non-Windows shells the directory is the repo's `frontend/`.
- **Types:** Consume only the snake_case DB-shaped types from `@/lib/trip/backend-types`. Never introduce a camelCase trip shape. The `@/` alias maps to `frontend/` (e.g. `@/lib/trip/backend-types` → `frontend/lib/trip/backend-types.ts`).
- **Data seam:** Components get data **only** through `@/lib/trip/mock-api`. Never import `@/lib/trip/fixtures` in component source (tests may). Never import `@/lib/trip/api` or `@/lib/trip/sse` — those are legacy real-backend wiring and are out of scope.
- **Styling:** Reuse the existing design tokens in `app/globals.css`. Colors via CSS vars through Tailwind arbitrary values: `bg-[var(--void)]`, `bg-[var(--deep)]`, `bg-[var(--elevated)]`, `text-[var(--starlight)]`, `text-[var(--muted)]`, `text-[var(--faint)]`, `text-[var(--brass)]`, `border-[var(--line)]`, `bg-[var(--brass-soft)]`. Use utility classes `.surface` (panel bg+border), `.type-display` (serif), `.type-body`, `.type-label` (mono). Brass `#C9974E` is the single accent.
- **Icons:** Inline SVG only. No icon library (STACK is frozen — no new deps).
- **Reel limits (PRD §7/§9):** Max **5** Reel URLs per trip. Minimum input to generate: **at least one Reel URL OR at least one requested place.** Every other Brief field is optional.
- **Anti-hallucination (PRD §12/§15):** Every inspiration item surfaces its status; requested places keep the user's **verbatim** text. Never fabricate a place — the tray only records what the user pasted or typed.
- **Client directive:** Any component with an event handler, a hook, or browser APIs starts with `'use client'`. `app/app/page.tsx` stays a server component that renders the client flow.
- **Tests:** Vitest + @testing-library/react. Import `describe, it, expect, vi, beforeEach` from `'vitest'` and `render, screen, fireEvent, waitFor` from `'@testing-library/react'`. Fixture data (only where a test needs it) via `import { TOKYO_TRIP } from '@/lib/trip/fixtures'`.
- **Commits:** One commit per task, present-tense `feat(frontend): …` / `test(frontend): …`. A `.githooks/post-commit` prompt may appear and auto-skips after 15s — let it; do not answer it.
- **Green gate:** Before every commit, `npm test` (full suite) passes and `npm run typecheck` exits 0.

---

## Existing types you will consume (already defined — do NOT redefine)

From `frontend/lib/trip/backend-types.ts`:

```ts
export type BudgetLevel = 'budget' | 'mid_range' | 'premium' | 'luxury'
export type InspirationItemType = 'reel_url' | 'requested_place'
export type InspirationSource = 'manual_paste' | 'clipboard' | 'web_share_target' | 'manual_input'
export type InspirationStatus =
  | 'valid' | 'invalid' | 'duplicate' | 'queued' | 'cached' | 'processing'
  | 'places_found' | 'needs_review' | 'failed'
  | 'pending_resolution' | 'resolved' | 'ambiguous' | 'unresolved'
export type GenerationStage =
  | 'create_trip' | 'scrape' | 'cache_hit' | 'extract' | 'resolve' | 'preferences'
  | 'dedup' | 'enrich' | 'weather' | 'restaurants' | 'hotels' | 'transport'
  | 'narrate' | 'summarize' | 'save'

export type StageEvent = { type: 'stage'; stage: GenerationStage; msg: string }
export type HeartbeatEvent = { type: 'heartbeat'; elapsed_s: number }
export type ResultEvent = { type: 'result'; content: string }
export type StreamEvent = StageEvent | HeartbeatEvent | ResultEvent

export type GenerateTripRequest = {
  reel_urls: string[]
  requested_places: string[]
  destination_hint: string | null
  start_date: string | null
  end_date: string | null
  budget_level: BudgetLevel | null
  origin_city: string | null
  preferences: string | null
}
export type GenerateTripResponse = { trip_id: string }
```

The mock seam `frontend/lib/trip/mock-api.ts` **already** exports `streamGeneration(tripId, onEvent): { cancel: () => void }` (a scripted `StreamEvent` emitter ending with a `result` event whose `content` is `JSON.stringify({ trip_id })`). Task 2 adds `createTrip` next to it.

---

## File Structure

- `lib/trip/parse-inspiration.ts` (new) — pure module: reel-URL normalization, paste parsing, dedup/cap, requested-place creation, `canGenerate`, `toGenerateRequest`. Exports the client-side `DraftInspirationItem` and `BriefInput` types.
- `lib/trip/__tests__/parse-inspiration.test.ts` (new) — unit tests.
- `lib/trip/mock-api.ts` (modify) — add `createTrip(req): Promise<GenerateTripResponse>`.
- `lib/trip/__tests__/mock-api.test.ts` (modify) — add `createTrip` tests.
- `components/create/InspirationTray.tsx` (new, client) — paste box + requested-place input + inspiration cards.
- `components/create/__tests__/InspirationTray.test.tsx` (new).
- `components/create/TripBriefForm.tsx` (new, client) — optional Brief fields.
- `components/create/__tests__/TripBriefForm.test.tsx` (new).
- `components/create/GenerationProgress.tsx` (new, client) — live SSE stage timeline (presentational; consumes an events array).
- `components/create/__tests__/GenerationProgress.test.tsx` (new).
- `components/create/CreateTripFlow.tsx` (new, client) — orchestrator + phase machine + seam calls + routing.
- `components/create/__tests__/CreateTripFlow.test.tsx` (new).
- `app/app/page.tsx` (rewrite the `return null` placeholder) — server wrapper rendering `<CreateTripFlow />`.

Leave these legacy files untouched (they are orphaned; do not import them): `components/trip/ReelInputPanel.tsx`, `components/trip/GenerationTimeline.tsx`, `lib/trip/api.ts`, `lib/trip/sse.ts`, `lib/trip/types.ts`, `lib/trip/normalize-trip.ts`.

---

## Task 1: Inspiration parsing module

**Files:**
- Create: `lib/trip/parse-inspiration.ts`
- Test: `lib/trip/__tests__/parse-inspiration.test.ts`

**Interfaces:**
- Consumes: `InspirationItemType`, `InspirationSource`, `InspirationStatus`, `BudgetLevel`, `GenerateTripRequest` from `@/lib/trip/backend-types`.
- Produces (later tasks rely on these **exact** names/signatures):
  - `MAX_REELS = 5`
  - type `DraftInspirationItem = { key: string; item_type: InspirationItemType; source: InspirationSource; normalized_reel_url: string | null; requested_place_text: string | null; status: InspirationStatus }`
  - type `BriefInput = { destination_hint: string; start_date: string; end_date: string; origin_city: string; budget_level: BudgetLevel | ''; preferences: string }`
  - `normalizeReelUrl(raw: string): string | null`
  - `buildReelItems(rawText: string, existing: DraftInspirationItem[]): { items: DraftInspirationItem[]; addedCount: number; duplicateCount: number; invalidCount: number; overCapCount: number }`
  - `makeRequestedPlace(text: string, existing: DraftInspirationItem[]): DraftInspirationItem | null`
  - `canGenerate(items: DraftInspirationItem[]): boolean`
  - `toGenerateRequest(items: DraftInspirationItem[], brief: BriefInput): GenerateTripRequest`

- [ ] **Step 1: Write the failing test**

```ts
// lib/trip/__tests__/parse-inspiration.test.ts
import { describe, it, expect } from 'vitest'
import {
  MAX_REELS, normalizeReelUrl, buildReelItems, makeRequestedPlace,
  canGenerate, toGenerateRequest,
  type DraftInspirationItem, type BriefInput,
} from '@/lib/trip/parse-inspiration'

const EMPTY_BRIEF: BriefInput = {
  destination_hint: '', start_date: '', end_date: '',
  origin_city: '', budget_level: '', preferences: '',
}

describe('normalizeReelUrl', () => {
  it('canonicalizes reel/reels/p/tv forms to https reel URL, stripping query + fragment', () => {
    expect(normalizeReelUrl('https://www.instagram.com/reel/ABC123/')).toBe('https://www.instagram.com/reel/ABC123/')
    expect(normalizeReelUrl('instagram.com/reels/XYZ_9')).toBe('https://www.instagram.com/reel/XYZ_9/')
    expect(normalizeReelUrl('https://m.instagram.com/p/POST1/?igsh=abc#x')).toBe('https://www.instagram.com/p/POST1/')
    expect(normalizeReelUrl('https://www.instagram.com/share/reel/SH99/')).toBe('https://www.instagram.com/reel/SH99/')
  })

  it('returns null for non-Instagram or malformed input', () => {
    expect(normalizeReelUrl('https://tiktok.com/@x/video/1')).toBeNull()
    expect(normalizeReelUrl('just some text')).toBeNull()
    expect(normalizeReelUrl('instagram.com/accounts/login')).toBeNull()
  })

  it('rejects look-alike domains that merely contain "instagram.com" as a substring', () => {
    expect(normalizeReelUrl('https://notinstagram.com/reel/ABC')).toBeNull()
    expect(normalizeReelUrl('https://instagram.com.evil.com/reel/ABC')).toBeNull()
    expect(normalizeReelUrl('xinstagram.com/reel/ABC')).toBeNull()
  })
})

describe('buildReelItems', () => {
  it('extracts + normalizes reel URLs from messy text and ignores prose', () => {
    const res = buildReelItems('omg check https://www.instagram.com/reel/AAA/ and https://instagram.com/reels/BBB please', [])
    expect(res.addedCount).toBe(2)
    expect(res.items.map((i) => i.normalized_reel_url)).toEqual([
      'https://www.instagram.com/reel/AAA/',
      'https://www.instagram.com/reel/BBB/',
    ])
    expect(res.items.every((i) => i.item_type === 'reel_url' && i.status === 'valid')).toBe(true)
  })

  it('deduplicates against existing items and within the batch', () => {
    const first = buildReelItems('https://www.instagram.com/reel/AAA/', [])
    const res = buildReelItems('https://www.instagram.com/reels/AAA/ https://www.instagram.com/reel/CCC/', first.items)
    expect(res.duplicateCount).toBe(1)
    expect(res.addedCount).toBe(1)
    expect(res.items.filter((i) => i.item_type === 'reel_url')).toHaveLength(2)
  })

  it('caps reels at MAX_REELS and reports the overflow', () => {
    const text = Array.from({ length: 7 }, (_, n) => `https://www.instagram.com/reel/R${n}/`).join('\n')
    const res = buildReelItems(text, [])
    expect(res.addedCount).toBe(MAX_REELS)
    expect(res.overCapCount).toBe(7 - MAX_REELS)
  })

  it('counts Instagram-looking tokens that fail to normalize as invalid', () => {
    const res = buildReelItems('https://www.instagram.com/accounts/login', [])
    expect(res.addedCount).toBe(0)
    expect(res.invalidCount).toBe(1)
  })
})

describe('makeRequestedPlace', () => {
  it('creates a requested_place item keeping verbatim text', () => {
    const item = makeRequestedPlace('  Tokyo Disneyland ', [])
    expect(item).not.toBeNull()
    expect(item!.item_type).toBe('requested_place')
    expect(item!.requested_place_text).toBe('Tokyo Disneyland')
    expect(item!.status).toBe('pending_resolution')
  })

  it('returns null for blank text or a case-insensitive duplicate', () => {
    const first = makeRequestedPlace('Shibuya', [])!
    expect(makeRequestedPlace('   ', [])).toBeNull()
    expect(makeRequestedPlace('shibuya', [first])).toBeNull()
  })
})

describe('canGenerate', () => {
  it('is true with at least one reel or one place, false when empty', () => {
    expect(canGenerate([])).toBe(false)
    expect(canGenerate([makeRequestedPlace('Kyoto', [])!])).toBe(true)
    expect(canGenerate(buildReelItems('https://www.instagram.com/reel/AAA/', []).items)).toBe(true)
  })
})

describe('toGenerateRequest', () => {
  it('splits items into reel_urls + requested_places and nulls empty brief fields', () => {
    const items: DraftInspirationItem[] = [
      ...buildReelItems('https://www.instagram.com/reel/AAA/', []).items,
      makeRequestedPlace('Tokyo Disneyland', [])!,
    ]
    const req = toGenerateRequest(items, { ...EMPTY_BRIEF, destination_hint: 'Tokyo', budget_level: 'mid_range' })
    expect(req.reel_urls).toEqual(['https://www.instagram.com/reel/AAA/'])
    expect(req.requested_places).toEqual(['Tokyo Disneyland'])
    expect(req.destination_hint).toBe('Tokyo')
    expect(req.budget_level).toBe('mid_range')
    expect(req.start_date).toBeNull()
    expect(req.origin_city).toBeNull()
    expect(req.preferences).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- parse-inspiration`
Expected: FAIL — `Failed to resolve import "@/lib/trip/parse-inspiration"` (the module does not exist yet).

- [ ] **Step 3: Write the implementation**

```ts
// lib/trip/parse-inspiration.ts
import type {
  InspirationItemType, InspirationSource, InspirationStatus,
  BudgetLevel, GenerateTripRequest,
} from '@/lib/trip/backend-types'

export const MAX_REELS = 5

export type DraftInspirationItem = {
  key: string // stable React key: the normalized URL (reels) or `place:<lowercased text>` (places)
  item_type: InspirationItemType
  source: InspirationSource
  normalized_reel_url: string | null
  requested_place_text: string | null
  status: InspirationStatus
}

export type BriefInput = {
  destination_hint: string
  start_date: string
  end_date: string
  origin_city: string
  budget_level: BudgetLevel | ''
  preferences: string
}

// Accepts reel / reels / p / tv, optionally under /share/, with or without scheme,
// on host instagram.com (or www./m. subdomains only), ignoring any query string or fragment.
// The leading (?:^|\/\/|\s) boundary anchors the host so a look-alike domain such as
// "notinstagram.com" or "instagram.com.evil.com" is rejected, not matched on substring.
// Canonical output: https://www.instagram.com/<type>/<code>/
const IG_RE = /(?:^|\/\/|\s)(?:www\.|m\.)?instagram\.com\/(?:share\/)?(reel|reels|p|tv)\/([A-Za-z0-9_-]+)/i

export function normalizeReelUrl(raw: string): string | null {
  const m = raw.match(IG_RE)
  if (!m) return null
  const type = m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase()
  return `https://www.instagram.com/${type}/${m[2]}/`
}

function reelCount(items: DraftInspirationItem[]): number {
  return items.filter((i) => i.item_type === 'reel_url').length
}

export function buildReelItems(
  rawText: string,
  existing: DraftInspirationItem[],
): { items: DraftInspirationItem[]; addedCount: number; duplicateCount: number; invalidCount: number; overCapCount: number } {
  const seen = new Set(
    existing.filter((i) => i.item_type === 'reel_url').map((i) => i.normalized_reel_url),
  )
  const added: DraftInspirationItem[] = []
  let duplicateCount = 0, invalidCount = 0, overCapCount = 0

  for (const token of rawText.split(/\s+/).filter(Boolean)) {
    if (!/instagram\.com/i.test(token)) continue // prose — not a link
    const norm = normalizeReelUrl(token)
    if (!norm) { invalidCount++; continue }
    if (seen.has(norm)) { duplicateCount++; continue }
    if (reelCount(existing) + added.length >= MAX_REELS) { overCapCount++; continue }
    seen.add(norm)
    added.push({
      key: norm, item_type: 'reel_url', source: 'manual_paste',
      normalized_reel_url: norm, requested_place_text: null, status: 'valid',
    })
  }

  return { items: [...existing, ...added], addedCount: added.length, duplicateCount, invalidCount, overCapCount }
}

export function makeRequestedPlace(
  text: string,
  existing: DraftInspirationItem[],
): DraftInspirationItem | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const key = `place:${trimmed.toLowerCase()}`
  if (existing.some((i) => i.item_type === 'requested_place' && i.key === key)) return null
  return {
    key, item_type: 'requested_place', source: 'manual_input',
    normalized_reel_url: null, requested_place_text: trimmed, status: 'pending_resolution',
  }
}

export function canGenerate(items: DraftInspirationItem[]): boolean {
  return items.length > 0 // any reel OR any requested place satisfies the PRD §9 minimum
}

export function toGenerateRequest(items: DraftInspirationItem[], brief: BriefInput): GenerateTripRequest {
  const clean = (s: string): string | null => {
    const t = s.trim()
    return t.length ? t : null
  }
  return {
    reel_urls: items.filter((i) => i.item_type === 'reel_url' && i.normalized_reel_url).map((i) => i.normalized_reel_url as string),
    requested_places: items.filter((i) => i.item_type === 'requested_place' && i.requested_place_text).map((i) => i.requested_place_text as string),
    destination_hint: clean(brief.destination_hint),
    start_date: clean(brief.start_date),
    end_date: clean(brief.end_date),
    budget_level: brief.budget_level || null,
    origin_city: clean(brief.origin_city),
    preferences: clean(brief.preferences),
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- parse-inspiration`
Expected: PASS — all `parse-inspiration` tests green.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expected: exit 0, no output)

```bash
git add lib/trip/parse-inspiration.ts lib/trip/__tests__/parse-inspiration.test.ts
git commit -m "feat(frontend): inspiration parsing module (reel normalize, dedup, cap, request assembly)"
```

---

## Task 2: `createTrip` mock seam

**Files:**
- Modify: `lib/trip/mock-api.ts`
- Test: `lib/trip/__tests__/mock-api.test.ts` (append)

**Interfaces:**
- Consumes: `GenerateTripRequest`, `GenerateTripResponse` from `@/lib/trip/backend-types`; `TOKYO_TRIP` from `@/lib/trip/fixtures`.
- Produces: `createTrip(req: GenerateTripRequest): Promise<GenerateTripResponse>` — resolves `{ trip_id: TOKYO_TRIP.trip.id }` when the request has at least one reel or place; rejects otherwise.

- [ ] **Step 1: Write the failing test (append to the existing file)**

First, edit the two import lines at the top of the file. It currently starts:

```ts
import { describe, it, expect, vi } from 'vitest'
import { getTrip, listTrips, getProfile, submitFeedback, streamGeneration } from '@/lib/trip/mock-api'
import type { StreamEvent } from '@/lib/trip/backend-types'
```

Add `createTrip` to line 2 and add a `TOKYO_TRIP` import, so the top becomes:

```ts
import { describe, it, expect, vi } from 'vitest'
import { getTrip, listTrips, getProfile, submitFeedback, streamGeneration, createTrip } from '@/lib/trip/mock-api'
import type { StreamEvent } from '@/lib/trip/backend-types'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
```

Then append this block as a **sibling** `describe` at the very end of the file (after the closing `})` of the existing `describe('mock-api', …)` block — keep every existing test intact):

```ts
describe('createTrip', () => {
  it('returns the demo trip id for a request with at least one reel', async () => {
    const res = await createTrip({
      reel_urls: ['https://www.instagram.com/reel/AAA/'], requested_places: [],
      destination_hint: null, start_date: null, end_date: null,
      budget_level: null, origin_city: null, preferences: null,
    })
    expect(res.trip_id).toBe(TOKYO_TRIP.trip.id)
  })

  it('accepts a request with only a requested place', async () => {
    const res = await createTrip({
      reel_urls: [], requested_places: ['Tokyo Disneyland'],
      destination_hint: null, start_date: null, end_date: null,
      budget_level: null, origin_city: null, preferences: null,
    })
    expect(res.trip_id).toBe(TOKYO_TRIP.trip.id)
  })

  it('rejects a request with no reels and no requested places', async () => {
    await expect(createTrip({
      reel_urls: [], requested_places: [],
      destination_hint: null, start_date: null, end_date: null,
      budget_level: null, origin_city: null, preferences: null,
    })).rejects.toThrow(/at least one/i)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- mock-api`
Expected: FAIL — `createTrip is not a function` (or an import error for `createTrip`).

- [ ] **Step 3: Write the implementation**

Add to `lib/trip/mock-api.ts`. Extend the top import to include the request/response types, then add the function (place it just above the `SCRIPT` constant):

```ts
// --- extend the existing top-of-file type import to add these two names ---
//   GenerateTripRequest, GenerateTripResponse
// e.g. it becomes:
// import type {
//   TripBundle, Trip, TravelerProfile, UserPreferenceFact, StreamEvent,
//   GenerateTripRequest, GenerateTripResponse,
// } from '@/lib/trip/backend-types'

// Simulates POST /trips: creates the durable trip row and returns its id (PRD §16: trip row < 2s).
// Offline/deterministic — always resolves to the Tokyo fixture so streamGeneration can chain onto it.
export async function createTrip(req: GenerateTripRequest): Promise<GenerateTripResponse> {
  await delay(MOCK_LATENCY_MS)
  if (req.reel_urls.length + req.requested_places.length < 1) {
    throw new Error('Provide at least one Reel URL or requested place to generate a trip.')
  }
  return { trip_id: TOKYO_TRIP.trip.id }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- mock-api`
Expected: PASS — including the three new `createTrip` cases.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expected: exit 0)

```bash
git add lib/trip/mock-api.ts lib/trip/__tests__/mock-api.test.ts
git commit -m "feat(frontend): add createTrip to the mock-api seam"
```

---

## Task 3: InspirationTray component

**Files:**
- Create: `components/create/InspirationTray.tsx`
- Test: `components/create/__tests__/InspirationTray.test.tsx`

**Interfaces:**
- Consumes: `DraftInspirationItem`, `buildReelItems`, `makeRequestedPlace`, `MAX_REELS` from `@/lib/trip/parse-inspiration`; `InspirationStatus` from `@/lib/trip/backend-types`.
- Produces: `<InspirationTray items={DraftInspirationItem[]} onChange={(items: DraftInspirationItem[]) => void} />` (default export). Controlled — never owns the item list; parent owns it.

- [ ] **Step 1: Write the failing test**

```tsx
// components/create/__tests__/InspirationTray.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import InspirationTray from '@/components/create/InspirationTray'
import { buildReelItems, makeRequestedPlace } from '@/lib/trip/parse-inspiration'

describe('InspirationTray', () => {
  it('parses a pasted reel URL into a card via onChange', () => {
    const onChange = vi.fn()
    render(<InspirationTray items={[]} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/paste.*reel/i), {
      target: { value: 'https://www.instagram.com/reel/AAA/' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add links/i }))
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0][0]
    expect(next).toHaveLength(1)
    expect(next[0].normalized_reel_url).toBe('https://www.instagram.com/reel/AAA/')
  })

  it('adds a requested place keeping the verbatim text', () => {
    const onChange = vi.fn()
    render(<InspirationTray items={[]} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/add a place/i), { target: { value: 'Tokyo Disneyland' } })
    fireEvent.click(screen.getByRole('button', { name: /add place/i }))
    const next = onChange.mock.calls[0][0]
    expect(next[0].requested_place_text).toBe('Tokyo Disneyland')
  })

  it('renders existing items with a type badge and a remove control', () => {
    const items = [
      ...buildReelItems('https://www.instagram.com/reel/AAA/', []).items,
      makeRequestedPlace('Shibuya Sky', [])!,
    ]
    const onChange = vi.fn()
    render(<InspirationTray items={items} onChange={onChange} />)
    expect(screen.getByText('Shibuya Sky')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: /remove/i })[0])
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0]).toHaveLength(1) // one item removed
  })

  it('shows the max-reels notice when five reels are present', () => {
    const items = buildReelItems(
      Array.from({ length: 5 }, (_, n) => `https://www.instagram.com/reel/R${n}/`).join('\n'), [],
    ).items
    render(<InspirationTray items={items} onChange={vi.fn()} />)
    expect(screen.getByText(/max.*5.*reel/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- InspirationTray`
Expected: FAIL — cannot resolve `@/components/create/InspirationTray`.

- [ ] **Step 3: Write the implementation**

```tsx
// components/create/InspirationTray.tsx
'use client'

import { useState } from 'react'
import type { InspirationStatus } from '@/lib/trip/backend-types'
import {
  buildReelItems, makeRequestedPlace, MAX_REELS,
  type DraftInspirationItem,
} from '@/lib/trip/parse-inspiration'

const STATUS_LABEL: Partial<Record<InspirationStatus, string>> = {
  valid: 'Ready',
  pending_resolution: 'Will confirm',
}

function TypeBadge({ item }: { item: DraftInspirationItem }) {
  const isReel = item.item_type === 'reel_url'
  return (
    <span className="type-label rounded-full border border-[var(--line)] px-2 py-0.5 text-[10px] uppercase tracking-wide text-[var(--faint)]">
      {isReel ? 'Reel' : 'Requested'}
    </span>
  )
}

function Card({ item, onRemove }: { item: DraftInspirationItem; onRemove: () => void }) {
  const primary = item.item_type === 'reel_url' ? item.normalized_reel_url : item.requested_place_text
  return (
    <li className="surface flex items-center gap-3 rounded-lg p-3">
      <TypeBadge item={item} />
      <span className="type-body min-w-0 flex-1 truncate text-sm text-[var(--starlight)]">{primary}</span>
      <span className="type-label text-[10px] uppercase tracking-wide text-[var(--brass)]">
        {STATUS_LABEL[item.status] ?? item.status}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${primary ?? 'item'}`}
        className="type-label text-[var(--faint)] transition-colors hover:text-[var(--starlight)]"
      >
        ✕
      </button>
    </li>
  )
}

export default function InspirationTray({
  items, onChange,
}: {
  items: DraftInspirationItem[]
  onChange: (items: DraftInspirationItem[]) => void
}) {
  const [paste, setPaste] = useState('')
  const [placeText, setPlaceText] = useState('')
  const [message, setMessage] = useState('')

  const reelCount = items.filter((i) => i.item_type === 'reel_url').length
  const atMax = reelCount >= MAX_REELS

  function addLinks() {
    const res = buildReelItems(paste, items)
    onChange(res.items)
    setPaste('')
    const parts: string[] = []
    if (res.addedCount) parts.push(`${res.addedCount} link${res.addedCount > 1 ? 's' : ''} added`)
    if (res.duplicateCount) parts.push(`${res.duplicateCount} duplicate`)
    if (res.overCapCount) parts.push(`${res.overCapCount} over the max of ${MAX_REELS}`)
    if (res.invalidCount) parts.push(`${res.invalidCount} not a valid link`)
    setMessage(parts.join(' · ') || 'No Instagram links found.')
  }

  function addPlace() {
    const item = makeRequestedPlace(placeText, items)
    if (item) {
      onChange([...items, item])
      setPlaceText('')
      setMessage('')
    } else {
      setMessage('Enter a new place name.')
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="reel-paste" className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)]">
          Paste Instagram Reel links
        </label>
        <textarea
          id="reel-paste"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          rows={3}
          placeholder="https://www.instagram.com/reel/…"
          className="surface type-body rounded-lg p-3 text-sm text-[var(--starlight)] placeholder:text-[var(--faint)]"
        />
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={addLinks}
            className="type-label rounded-lg border border-[var(--brass)] bg-[var(--brass-soft)] px-3 py-1.5 text-xs uppercase tracking-wide text-[var(--starlight)]"
          >
            Add links
          </button>
          <span className="type-label text-[10px] uppercase tracking-wide text-[var(--faint)]">
            {reelCount} / {MAX_REELS} reels
          </span>
        </div>
        {atMax ? (
          <p className="type-label text-[10px] uppercase tracking-wide text-[var(--brass)]">
            Max {MAX_REELS} Reels reached.
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="place-input" className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)]">
          Add a place you want to visit
        </label>
        <div className="flex gap-2">
          <input
            id="place-input"
            value={placeText}
            onChange={(e) => setPlaceText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPlace() } }}
            placeholder="e.g. Tokyo Disneyland"
            className="surface type-body flex-1 rounded-lg p-2.5 text-sm text-[var(--starlight)] placeholder:text-[var(--faint)]"
          />
          <button
            type="button"
            onClick={addPlace}
            className="type-label rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs uppercase tracking-wide text-[var(--muted)] hover:text-[var(--starlight)]"
          >
            Add place
          </button>
        </div>
      </div>

      {message ? (
        <p className="type-body text-xs text-[var(--muted)]" role="status">{message}</p>
      ) : null}

      {items.length ? (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <Card key={item.key} item={item} onRemove={() => onChange(items.filter((i) => i.key !== item.key))} />
          ))}
        </ul>
      ) : (
        <p className="type-body text-sm text-[var(--faint)]">
          Add at least one Reel link or a place to begin.
        </p>
      )}
    </section>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- InspirationTray`
Expected: PASS — all four cases.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expected: exit 0)

```bash
git add components/create/InspirationTray.tsx components/create/__tests__/InspirationTray.test.tsx
git commit -m "feat(frontend): inspiration tray with reel paste + requested places"
```

---

## Task 4: TripBriefForm component

**Files:**
- Create: `components/create/TripBriefForm.tsx`
- Test: `components/create/__tests__/TripBriefForm.test.tsx`

**Interfaces:**
- Consumes: `BriefInput` from `@/lib/trip/parse-inspiration`; `BudgetLevel` from `@/lib/trip/backend-types`.
- Produces: `<TripBriefForm brief={BriefInput} onChange={(brief: BriefInput) => void} />` (default export). Controlled — parent owns `brief`.

- [ ] **Step 1: Write the failing test**

```tsx
// components/create/__tests__/TripBriefForm.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import TripBriefForm from '@/components/create/TripBriefForm'
import type { BriefInput } from '@/lib/trip/parse-inspiration'

const BRIEF: BriefInput = {
  destination_hint: '', start_date: '', end_date: '',
  origin_city: '', budget_level: '', preferences: '',
}

describe('TripBriefForm', () => {
  it('emits the edited destination hint through onChange', () => {
    const onChange = vi.fn()
    render(<TripBriefForm brief={BRIEF} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/destination/i), { target: { value: 'Tokyo' } })
    expect(onChange).toHaveBeenCalledWith({ ...BRIEF, destination_hint: 'Tokyo' })
  })

  it('emits the selected budget level', () => {
    const onChange = vi.fn()
    render(<TripBriefForm brief={BRIEF} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/budget/i), { target: { value: 'mid_range' } })
    expect(onChange).toHaveBeenCalledWith({ ...BRIEF, budget_level: 'mid_range' })
  })

  it('shows the inferred-default helper copy when preferences are empty', () => {
    render(<TripBriefForm brief={BRIEF} onChange={vi.fn()} />)
    expect(screen.getByText(/astrail will infer your trip style/i)).toBeInTheDocument()
  })

  it('hides the inferred-default helper once preferences are provided', () => {
    render(<TripBriefForm brief={{ ...BRIEF, preferences: 'ramen and walkable days' }} onChange={vi.fn()} />)
    expect(screen.queryByText(/astrail will infer your trip style/i)).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- TripBriefForm`
Expected: FAIL — cannot resolve `@/components/create/TripBriefForm`.

- [ ] **Step 3: Write the implementation**

```tsx
// components/create/TripBriefForm.tsx
'use client'

import type { BudgetLevel } from '@/lib/trip/backend-types'
import type { BriefInput } from '@/lib/trip/parse-inspiration'

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

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="start-date" className={labelClass}>Start date</label>
          <input id="start-date" type="date" className={fieldClass}
            value={brief.start_date} onChange={(e) => set('start_date', e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="end-date" className={labelClass}>End date</label>
          <input id="end-date" type="date" className={fieldClass}
            value={brief.end_date} onChange={(e) => set('end_date', e.target.value)} />
        </div>
      </div>

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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- TripBriefForm`
Expected: PASS — all four cases.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expected: exit 0)

```bash
git add components/create/TripBriefForm.tsx components/create/__tests__/TripBriefForm.test.tsx
git commit -m "feat(frontend): optional trip brief form"
```

---

## Task 5: GenerationProgress component

**Files:**
- Create: `components/create/GenerationProgress.tsx`
- Test: `components/create/__tests__/GenerationProgress.test.tsx`

**Interfaces:**
- Consumes: `StreamEvent`, `GenerationStage` from `@/lib/trip/backend-types`.
- Produces: `<GenerationProgress events={StreamEvent[]} />` (default export). Presentational — renders the accumulated stream; the parent owns the stream subscription. Root element carries `data-testid="generation-progress"`.

- [ ] **Step 1: Write the failing test**

```tsx
// components/create/__tests__/GenerationProgress.test.tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import GenerationProgress from '@/components/create/GenerationProgress'
import type { StreamEvent } from '@/lib/trip/backend-types'

describe('GenerationProgress', () => {
  it('renders each stage event with its human label and message', () => {
    const events: StreamEvent[] = [
      { type: 'stage', stage: 'scrape', msg: 'Scraping 3 Reels…' },
      { type: 'stage', stage: 'dedup', msg: 'Mapped 4 verified places.' },
    ]
    render(<GenerationProgress events={events} />)
    expect(screen.getByText(/scraping reels/i)).toBeInTheDocument()
    expect(screen.getByText('Scraping 3 Reels…')).toBeInTheDocument()
    expect(screen.getByText('Mapped 4 verified places.')).toBeInTheDocument()
  })

  it('shows the completion line on the terminal result event', () => {
    const events: StreamEvent[] = [
      { type: 'stage', stage: 'summarize', msg: 'Summarizing…' },
      { type: 'result', content: JSON.stringify({ trip_id: 'trip_tokyo_demo' }) },
    ]
    render(<GenerationProgress events={events} />)
    expect(screen.getByText(/opening your trip/i)).toBeInTheDocument()
  })

  it('renders a waiting state before any event arrives', () => {
    render(<GenerationProgress events={[]} />)
    expect(screen.getByTestId('generation-progress')).toBeInTheDocument()
    expect(screen.getByText(/starting/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- GenerationProgress`
Expected: FAIL — cannot resolve `@/components/create/GenerationProgress`.

- [ ] **Step 3: Write the implementation**

```tsx
// components/create/GenerationProgress.tsx
'use client'

import type { StreamEvent, GenerationStage } from '@/lib/trip/backend-types'

const STAGE_LABEL: Record<GenerationStage, string> = {
  create_trip: 'Creating your trip',
  scrape: 'Scraping Reels',
  cache_hit: 'Using cached Reel',
  extract: 'Extracting places',
  resolve: 'Resolving your requests',
  preferences: 'Applying preferences',
  dedup: 'Mapping verified places',
  enrich: 'Enriching places',
  weather: 'Checking weather',
  restaurants: 'Finding restaurants',
  hotels: 'Searching hotels',
  transport: 'Planning routes',
  narrate: 'Writing your days',
  summarize: 'Summarizing',
  save: 'Saving trip',
}

export default function GenerationProgress({ events }: { events: StreamEvent[] }) {
  return (
    <section data-testid="generation-progress" className="mx-auto flex w-full max-w-xl flex-col gap-4 p-6">
      <h1 className="type-display text-2xl text-[var(--starlight)]">Building your trip</h1>
      <p className="type-body text-sm text-[var(--muted)]">
        Astrail is turning your inspiration into a mapped route. Pins appear as places are verified.
      </p>

      {events.length === 0 ? (
        <p className="type-label text-xs uppercase tracking-wide text-[var(--faint)]">Starting…</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {events.map((event, i) => {
            if (event.type === 'heartbeat') {
              return (
                <li key={i} className="type-label pl-4 text-[10px] uppercase tracking-wide text-[var(--faint)]">
                  {event.elapsed_s.toFixed(1)}s elapsed
                </li>
              )
            }
            if (event.type === 'result') {
              return (
                <li key={i} className="type-body flex items-center gap-2 text-sm text-[var(--brass)]">
                  <span aria-hidden>✓</span> Trip ready — opening your trip…
                </li>
              )
            }
            const mapped = event.stage === 'dedup'
            return (
              <li key={i} className="surface flex flex-col gap-0.5 rounded-lg p-3">
                <span className={[
                  'type-label text-[10px] uppercase tracking-wide',
                  mapped ? 'text-[var(--brass)]' : 'text-[var(--muted)]',
                ].join(' ')}>
                  {STAGE_LABEL[event.stage]}
                </span>
                <span className="type-body text-sm text-[var(--starlight)]">{event.msg}</span>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- GenerationProgress`
Expected: PASS — all three cases.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` (expected: exit 0)

```bash
git add components/create/GenerationProgress.tsx components/create/__tests__/GenerationProgress.test.tsx
git commit -m "feat(frontend): live generation progress timeline"
```

---

## Task 6: CreateTripFlow orchestrator + wire `/app`

**Files:**
- Create: `components/create/CreateTripFlow.tsx`
- Test: `components/create/__tests__/CreateTripFlow.test.tsx`
- Rewrite: `app/app/page.tsx`

**Interfaces:**
- Consumes: `createTrip`, `streamGeneration` from `@/lib/trip/mock-api`; `canGenerate`, `toGenerateRequest`, `DraftInspirationItem`, `BriefInput` from `@/lib/trip/parse-inspiration`; `StreamEvent` from `@/lib/trip/backend-types`; `useRouter` from `next/navigation`; the three components from Tasks 3–5.
- Produces: `<CreateTripFlow />` (default export, no props). Owns `items`, `brief`, `phase` (`'compose' | 'generating'`), and the accumulated `events`.

> **Vitest mock note (READ THIS):** `vi.mock(...)` factories are hoisted **above** the file's imports and above top-level `const`s. Referencing a top-level `const` inside a factory throws a temporal-dead-zone `ReferenceError`. Define every value a factory needs inside `vi.hoisted(...)`, exactly as written below. Do not "simplify" it back to bare `const`s.

- [ ] **Step 1: Write the failing test**

```tsx
// components/create/__tests__/CreateTripFlow.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { push, createTrip, streamGeneration } = vi.hoisted(() => ({
  push: vi.fn(),
  createTrip: vi.fn(async () => ({ trip_id: 'trip_tokyo_demo' })),
  streamGeneration: vi.fn((_id: string, onEvent: (e: unknown) => void) => {
    onEvent({ type: 'stage', stage: 'scrape', msg: 'Scraping 3 Reels…' })
    onEvent({ type: 'stage', stage: 'dedup', msg: 'Mapped 4 verified places.' })
    onEvent({ type: 'result', content: JSON.stringify({ trip_id: 'trip_tokyo_demo' }) })
    return { cancel: () => {} }
  }),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/lib/trip/mock-api', () => ({ createTrip, streamGeneration }))

import CreateTripFlow from '@/components/create/CreateTripFlow'

describe('CreateTripFlow', () => {
  beforeEach(() => {
    push.mockClear(); createTrip.mockClear(); streamGeneration.mockClear()
  })

  it('disables Generate until there is at least one item', () => {
    render(<CreateTripFlow />)
    expect(screen.getByRole('button', { name: /generate/i })).toBeDisabled()
  })

  it('creates the trip, streams progress, and routes to the trip view', async () => {
    render(<CreateTripFlow />)
    fireEvent.change(screen.getByLabelText(/paste.*reel/i), {
      target: { value: 'https://www.instagram.com/reel/AAA/' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add links/i }))

    fireEvent.click(screen.getByRole('button', { name: /generate/i }))

    await waitFor(() => expect(createTrip).toHaveBeenCalledTimes(1))
    expect(streamGeneration).toHaveBeenCalledWith('trip_tokyo_demo', expect.any(Function))
    expect(await screen.findByText('Mapped 4 verified places.')).toBeInTheDocument()
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/trip/trip_tokyo_demo'))
  })

  it('does not start the stream or navigate if unmounted while createTrip is pending', async () => {
    let resolveCreate!: (v: { trip_id: string }) => void
    createTrip.mockImplementationOnce(() => new Promise((res) => { resolveCreate = res }))

    const { unmount } = render(<CreateTripFlow />)
    fireEvent.change(screen.getByLabelText(/paste.*reel/i), {
      target: { value: 'https://www.instagram.com/reel/AAA/' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add links/i }))
    fireEvent.click(screen.getByRole('button', { name: /generate/i }))

    await waitFor(() => expect(createTrip).toHaveBeenCalledTimes(1))
    unmount() // unmount BEFORE createTrip resolves
    resolveCreate({ trip_id: 'trip_tokyo_demo' })
    await Promise.resolve(); await Promise.resolve() // flush the awaited continuation

    expect(streamGeneration).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- CreateTripFlow`
Expected: FAIL — cannot resolve `@/components/create/CreateTripFlow`.

- [ ] **Step 3: Write the implementation**

```tsx
// components/create/CreateTripFlow.tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createTrip, streamGeneration } from '@/lib/trip/mock-api'
import {
  canGenerate, toGenerateRequest,
  type DraftInspirationItem, type BriefInput,
} from '@/lib/trip/parse-inspiration'
import type { StreamEvent } from '@/lib/trip/backend-types'
import InspirationTray from './InspirationTray'
import TripBriefForm from './TripBriefForm'
import GenerationProgress from './GenerationProgress'

const EMPTY_BRIEF: BriefInput = {
  destination_hint: '', start_date: '', end_date: '',
  origin_city: '', budget_level: '', preferences: '',
}

function tripIdFromResult(content: string, fallback: string): string {
  try {
    const parsed = JSON.parse(content) as { trip_id?: string }
    return parsed.trip_id ?? fallback
  } catch {
    return fallback
  }
}

export default function CreateTripFlow() {
  const router = useRouter()
  const [items, setItems] = useState<DraftInspirationItem[]>([])
  const [brief, setBrief] = useState<BriefInput>(EMPTY_BRIEF)
  const [phase, setPhase] = useState<'compose' | 'generating'>('compose')
  const [events, setEvents] = useState<StreamEvent[]>([])
  const handleRef = useRef<{ cancel: () => void } | null>(null)
  const activeRef = useRef(true)

  // Mounted-guard: createTrip is async (network latency). If the component unmounts
  // while it is pending, we must NOT start the stream afterward — otherwise the cleanup
  // (which already ran) can never cancel it, and its callback would setState / navigate
  // on an unmounted component. `activeRef` is re-armed on mount so StrictMode's
  // mount→unmount→mount double-invoke leaves it true.
  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
      handleRef.current?.cancel()
    }
  }, [])

  async function handleGenerate() {
    setPhase('generating')
    setEvents([])
    const { trip_id } = await createTrip(toGenerateRequest(items, brief))
    if (!activeRef.current) return // unmounted during createTrip — do not start the stream
    handleRef.current = streamGeneration(trip_id, (event) => {
      if (!activeRef.current) return
      setEvents((prev) => [...prev, event])
      if (event.type === 'result') {
        router.push(`/app/trip/${tripIdFromResult(event.content, trip_id)}`)
      }
    })
  }

  if (phase === 'generating') {
    return <GenerationProgress events={events} />
  }

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col gap-8 bg-[var(--void)] p-6">
      <header className="flex flex-col gap-1">
        <h1 className="type-display text-3xl text-[var(--starlight)]">Plan a new trip</h1>
        <p className="type-body text-sm text-[var(--muted)]">
          Paste the Reels that inspired you, add any must-visit places, and Astrail maps the route you actually take.
        </p>
      </header>

      <InspirationTray items={items} onChange={setItems} />
      <TripBriefForm brief={brief} onChange={setBrief} />

      <button
        type="button"
        onClick={handleGenerate}
        disabled={!canGenerate(items)}
        className="type-label rounded-xl border border-[var(--brass)] bg-[var(--brass-soft)] px-4 py-3 text-sm uppercase tracking-wide text-[var(--starlight)] transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
      >
        Generate my trip
      </button>
    </main>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- CreateTripFlow`
Expected: PASS — both cases (Generate disabled when empty; create → stream → route).

- [ ] **Step 5: Wire the `/app` page**

Replace the entire contents of `app/app/page.tsx` with:

```tsx
// app/app/page.tsx
import CreateTripFlow from '@/components/create/CreateTripFlow'

export default function AppHomePage() {
  return <CreateTripFlow />
}
```

- [ ] **Step 6: Run the FULL suite + typecheck**

Run: `npm test` — expected: ALL test files pass (the Plan 1 + Plan 2 suites plus the five new files from Tasks 1–6). Report the file/test counts.
Run: `npm run typecheck` — expected: exit 0, no output.

- [ ] **Step 7: Commit**

```bash
git add components/create/CreateTripFlow.tsx components/create/__tests__/CreateTripFlow.test.tsx app/app/page.tsx
git commit -m "feat(frontend): create-trip flow orchestrator wired at /app"
```

---

## Self-Review (run by the plan author, already done)

**Spec coverage vs. PRD §6–§9, §12, §16:**
- Inspiration Tray (paste reels, add places, statuses, remove, max-5) → Task 3, backed by Task 1's parser. ✅
- Min-input rule (≥1 reel OR ≥1 place) → `canGenerate` (Task 1) gates the Generate button (Task 6). ✅
- Trip Brief with all-optional fields + inferred-default copy → Task 4. ✅
- Generation phase with stage-by-stage timeline, "mapped places" emphasis (§16 first-value) → Task 5, driven by Task 6. ✅
- Route to trip view on completion → Task 6 (`router.push('/app/trip/{trip_id}')`). ✅
- Anti-hallucination: tray records only pasted/typed content; requested places keep verbatim text (Task 1/3). ✅
- Seam-only data: `createTrip` + `streamGeneration` from `@/lib/trip/mock-api`; no `api.ts`/`sse.ts` imports. ✅

**Type consistency:** `DraftInspirationItem`/`BriefInput` are defined once in Task 1 and imported everywhere. `toGenerateRequest` returns exactly `GenerateTripRequest`. `createTrip` returns `GenerateTripResponse`. `streamGeneration`'s callback receives `StreamEvent`. `GenerationProgress` consumes `StreamEvent[]`. No name drift.

**Placeholder scan:** every step contains complete code, an exact command, and expected output. No TODO/TBD.

**Known mechanical hazard flagged inline:** the Task 6 test uses `vi.hoisted` to avoid the `vi.mock` hoisting TDZ trap.

---

## Execution & Review Handoff

- **Executor:** Codex, following this plan task-by-task (TDD, one commit per task, verbatim transcription). Do not deviate from the code blocks; if a test needs a mechanical fix (import path / `vi.mock` hoisting / accessible-role query), fix the *test mechanics* without weakening any assertion, and note it in the task's commit body.
- **Reviewer:** the planning agent (Opus) reviews each commit's diff for spec compliance, anti-hallucination, seam purity, and non-vacuous tests, then runs a final whole-branch review + a manual browser verification (load `/app` with `NEXT_PUBLIC_MOCK_AUTH=true`: paste a reel, add a place, Generate, watch the timeline, land on `/app/trip/trip_tokyo_demo`).
- **Out of scope (later plans):** real backend wiring (`api.ts`/`sse.ts`), the Trip Brief as a separate confirm screen with scope warnings (kept inline here), clipboard/web-share ingestion, onboarding (Plan 4), trip list + settings (Plan 5).
