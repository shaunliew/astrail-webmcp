# Beta Wiring Implementation Plan — email OTP → onboarding → reels → itinerary on Mapbox

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing frontend and backend so a new user can sign up with email + 6-digit code, complete preference onboarding once, paste Reel URLs, watch live SSE stage events, and see the finished evidence-backed itinerary on the Mapbox map — saved, reloadable, and listed.

**Architecture:** No new services. Frontend swaps `mock-api` imports for the real FastAPI client (`lib/trip/api.ts`) and RLS-direct Supabase reads/writes (new `lib/trip/supabase-api.ts`). Backend gains request-schema parity and a preference-summary merge at trip creation. Auth becomes passwordless email OTP via Supabase.

**Tech Stack:** Next.js 15 + React 19 (Vercel), FastAPI + SSE (Render), Supabase (Auth/Postgres/RLS), Pydantic, vitest, pytest via uv. Stack is frozen — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-07-beta-auth-to-map-wiring-design.md` (amended 2026-07-07: dates required end-to-end; preference merge persists to trips row only — agent consumption stays deferred as the codebase's "Step 9").

## Global Constraints

- SSE termination contract (most breaking in repo): `data: {"type": "result", "content": "<JSON string>"}\n\n` then `data: [DONE]\n\n`. Error paths also end with `[DONE]`. Never rename existing event types. Backend `api/streaming.py` already complies — do not touch it.
- Guardrail #4 schema parity: Pydantic ↔ `frontend/lib/trip/backend-types.ts` ↔ `supabase/migrations` ship together. This plan adds NO new DB columns — all columns already exist.
- Guardrail #5/#6: every endpoint authenticated; every trip read/write owner-checked (RLS + explicit filters). Already true — do not weaken.
- Guardrail #8: pyproject + uv only. Run backend tests with `uv run pytest` from `backend/`.
- Guardrail #11: never feed raw user/profile text into a tool-call without the existing guardrails. This plan does NOT feed preference text to any agent (deferred "Step 9").
- Stack freeze: no new packages on either side. Everything here uses existing deps.
- No `legacy/` imports. No `requirements.txt`.
- Frontend commands from `frontend/`: `npm run typecheck`, `npm run test`. Backend from `backend/`: `uv run pytest <file> -v`.
- Existing dates flow: pipeline requires non-null `start_date`/`end_date` (ISO `YYYY-MM-DD`). Keep them required everywhere.
- Do not modify: `backend/api/streaming.py`, `backend/pipeline/runner.py`, `backend/jobs.py`, `frontend/components/map/TripMap.tsx`, any `supabase/migrations/*.sql` (all needed tables/policies exist — verified: `traveler_profiles` has select/insert/update own policies; `trip_places`, `trip_inspiration_items`, `places`, `trip_days`, `transport_legs`, `restaurant_suggestions`, `hotel_suggestions`, `generation_events` all have owner-scoped select policies).

---

### Task 1: Backend — request schema parity + preference merge

**Files:**
- Modify: `backend/api/schemas.py`
- Create: `backend/preferences.py`
- Create: `backend/test_preferences.py`
- Modify: `backend/main.py:68-132` (the `generate_trip` handler only)

**Interfaces:**
- Consumes: existing `get_supabase_client()`, `compute_idempotency_key`, `enqueue_job`, `record_event`, `run_generation` — signatures unchanged.
- Produces: `GenerateTripRequest` with new optional fields `requested_places: list[str]`, `budget_level: str | None`, `origin_city: str | None`, `preferences: str | None`; `preferences.fetch_traveler_profile(client, user_id) -> dict | None`; `preferences.compose_preference_summary(profile, trip_preferences) -> tuple[str | None, list[str]]`. Task 2's frontend request body matches this schema exactly.

- [ ] **Step 1: Write the failing tests for the preference composer**

Create `backend/test_preferences.py`:

```python
"""compose_preference_summary is a pure function — pin its contract."""
from preferences import compose_preference_summary


def test_profile_and_trip_notes_merge_with_sources():
    profile = {
        "origin_city": "Kuala Lumpur",
        "travel_style_tags": ["food-led", "walkable"],
        "preference_tags": ["ramen", "markets"],
        "preference_notes": "no early mornings",
    }
    summary, sources = compose_preference_summary(profile, "vegetarian this trip")
    assert "Travel style: food-led, walkable." in summary
    assert "Interests: ramen, markets." in summary
    assert "Notes: no early mornings" in summary
    assert "This trip: vegetarian this trip" in summary
    assert sources == ["memory", "explicit"]


def test_no_profile_only_trip_notes():
    summary, sources = compose_preference_summary(None, "halal food only")
    assert summary == "This trip: halal food only"
    assert sources == ["explicit"]


def test_empty_profile_and_no_notes_returns_none():
    summary, sources = compose_preference_summary(
        {"travel_style_tags": [], "preference_tags": [], "preference_notes": None}, None
    )
    assert summary is None
    assert sources == []


def test_profile_only():
    profile = {"travel_style_tags": ["relaxed"], "preference_tags": [], "preference_notes": None}
    summary, sources = compose_preference_summary(profile, None)
    assert summary == "Travel style: relaxed."
    assert sources == ["memory"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && uv run pytest test_preferences.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'preferences'`

- [ ] **Step 3: Implement `backend/preferences.py`**

```python
"""Compose trips.preference_summary from the traveler profile + per-trip notes.

Persist-only for now: NO agent consumes this text yet (that is the codebase's
deferred "Step 9", see pipeline/persist.py preference_match_json note). Keeping
the merge out of the pipeline also keeps guardrail #11 intact — profile text
never reaches a tool-call in this change.
"""
from __future__ import annotations


async def fetch_traveler_profile(client, user_id: str) -> dict | None:
    """Best-effort profile read; a missing row or DB blip returns None (never fails trip creation)."""
    try:
        res = await (
            client.table("traveler_profiles")
            .select("origin_city,travel_style_tags,preference_tags,preference_notes")
            .eq("id", user_id)
            .maybe_single()
            .execute()
        )
    except Exception:
        return None
    return None if res is None else res.data


def compose_preference_summary(
    profile: dict | None, trip_preferences: str | None
) -> tuple[str | None, list[str]]:
    """Merge profile prefs + per-trip notes into one summary string.

    Returns (summary, preference_sources) where sources uses the trips table's
    CHECK vocabulary: 'memory' (from stored profile) and 'explicit' (per-trip input).
    """
    parts: list[str] = []
    sources: list[str] = []
    if profile:
        profile_bits: list[str] = []
        style = ", ".join(profile.get("travel_style_tags") or [])
        interests = ", ".join(profile.get("preference_tags") or [])
        if style:
            profile_bits.append(f"Travel style: {style}.")
        if interests:
            profile_bits.append(f"Interests: {interests}.")
        if profile.get("preference_notes"):
            profile_bits.append(f"Notes: {profile['preference_notes']}")
        if profile_bits:
            parts.append(" ".join(profile_bits))
            sources.append("memory")
    if trip_preferences:
        parts.append(f"This trip: {trip_preferences}")
        sources.append("explicit")
    return ("\n".join(parts) or None), sources
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && uv run pytest test_preferences.py -v`
Expected: 4 PASS

- [ ] **Step 5: Extend the request schema**

In `backend/api/schemas.py`, replace `GenerateTripRequest` with:

```python
class GenerateTripRequest(BaseModel):
    reel_urls: list[str] = Field(min_length=1, max_length=5)
    start_date: str
    end_date: str
    destination_hint: str | None = None
    pace: str = "balanced"
    # Parity with frontend GenerateTripRequest (backend-types.ts). requested_places is
    # accepted + recorded but not yet resolved into the pipeline (deferred; see plan).
    requested_places: list[str] = Field(default_factory=list)
    budget_level: str | None = None
    origin_city: str | None = None
    preferences: str | None = None
```

- [ ] **Step 6: Persist the new fields in the trip insert**

In `backend/main.py`, add the import near the other local imports:

```python
from preferences import compose_preference_summary, fetch_traveler_profile
```

Inside `generate_trip`, AFTER the idempotency-replay check and BEFORE the trip insert, add:

```python
    profile = await fetch_traveler_profile(client, user_id)
    preference_summary, preference_sources = compose_preference_summary(profile, req.preferences)
    origin_city = req.origin_city or (profile.get("origin_city") if profile else None)
```

Replace the insert dict (currently `user_id/status/destination_hint/start_date/end_date`) with:

```python
        .insert({
            "user_id": user_id,
            "status": "generating",
            "destination_hint": req.destination_hint,
            "start_date": req.start_date,
            "end_date": req.end_date,
            "budget_level": req.budget_level,
            "origin_city": origin_city,
            "preference_summary": preference_summary,
            "preference_sources": preference_sources,
        })
```

In the `record_event(... stage="create_trip" ...)` payload, add one key so recovery replay and audit keep the full input (run_generation's signature does NOT change):

```python
                "requested_places": req.requested_places,
```

- [ ] **Step 7: Run the full backend test suite**

Run: `cd backend && uv run pytest -q`
Expected: all existing tests still pass (the new fields are optional; existing POST tests send the old shape and must not break). If any main.py test asserts the exact insert dict, update it to include the four new keys with `None`/`[]` values.

- [ ] **Step 8: Commit**

```bash
git add backend/api/schemas.py backend/preferences.py backend/test_preferences.py backend/main.py
git commit -m "feat(api): request schema parity + profile/per-trip preference merge on trip creation"
```

---

### Task 2: Frontend — type parity + require dates before Generate

**Files:**
- Modify: `frontend/lib/trip/backend-types.ts:214-223`
- Modify: `frontend/lib/trip/parse-inspiration.ts` (`canGenerate`, `toGenerateRequest`)
- Modify: `frontend/components/create/CreateTripFlow.tsx:84` (call site of `canGenerate`)
- Test: `frontend/lib/trip/__tests__/parse-inspiration.test.ts`

**Interfaces:**
- Consumes: `BriefInput` (unchanged), `DraftInspirationItem` (unchanged).
- Produces: `GenerateTripRequest.start_date: string` and `end_date: string` (non-null — matches Task 1's required Pydantic fields); `canGenerate(items: DraftInspirationItem[], brief: BriefInput): boolean` (NEW second parameter — Task 5 keeps this call shape).

- [ ] **Step 1: Update the type**

In `frontend/lib/trip/backend-types.ts`, change the two date fields of `GenerateTripRequest`:

```typescript
export type GenerateTripRequest = {
  reel_urls: string[]
  requested_places: string[]
  destination_hint: string | null
  start_date: string   // required — pipeline date-range needs real dates
  end_date: string     // required — pipeline date-range needs real dates
  budget_level: BudgetLevel | null
  origin_city: string | null
  preferences: string | null
}
```

- [ ] **Step 2: Write the failing tests**

In `frontend/lib/trip/__tests__/parse-inspiration.test.ts`, add (keep existing tests; update any that call `canGenerate(items)` with one argument or assert `start_date: null`):

```typescript
const FULL_BRIEF: BriefInput = {
  destination_hint: '', start_date: '2026-08-01', end_date: '2026-08-04',
  origin_city: '', budget_level: '', preferences: '',
}

describe('canGenerate with brief dates', () => {
  const reel: DraftInspirationItem = {
    key: 'https://www.instagram.com/reel/abc/', item_type: 'reel_url', source: 'manual_paste',
    normalized_reel_url: 'https://www.instagram.com/reel/abc/', requested_place_text: null, status: 'valid',
  }
  it('requires at least one item AND both dates', () => {
    expect(canGenerate([reel], FULL_BRIEF)).toBe(true)
    expect(canGenerate([], FULL_BRIEF)).toBe(false)
    expect(canGenerate([reel], { ...FULL_BRIEF, start_date: '' })).toBe(false)
    expect(canGenerate([reel], { ...FULL_BRIEF, end_date: '  ' })).toBe(false)
  })
})

describe('toGenerateRequest dates', () => {
  it('emits trimmed non-null dates', () => {
    const req = toGenerateRequest([], { ...FULL_BRIEF, start_date: ' 2026-08-01 ' })
    expect(req.start_date).toBe('2026-08-01')
    expect(req.end_date).toBe('2026-08-04')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd frontend && npm run test -- parse-inspiration`
Expected: FAIL (canGenerate arity / date types)

- [ ] **Step 4: Implement**

In `frontend/lib/trip/parse-inspiration.ts`, replace `canGenerate` and the two date lines of `toGenerateRequest`:

```typescript
export function canGenerate(items: DraftInspirationItem[], brief: BriefInput): boolean {
  // PRD §9 minimum (any reel or requested place) AND the pipeline's required date range.
  return items.length > 0 && brief.start_date.trim().length > 0 && brief.end_date.trim().length > 0
}
```

```typescript
    start_date: brief.start_date.trim(),
    end_date: brief.end_date.trim(),
```

In `frontend/components/create/CreateTripFlow.tsx` line 84, change:

```typescript
        disabled={!canGenerate(items, brief)}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd frontend && npm run test && npm run typecheck`
Expected: PASS. If `mock-api.test.ts` or `harness.test.ts` construct a `GenerateTripRequest` with null dates, update those fixtures to real date strings.

- [ ] **Step 6: Commit**

```bash
git add frontend/lib/trip/backend-types.ts frontend/lib/trip/parse-inspiration.ts frontend/components/create/CreateTripFlow.tsx frontend/lib/trip/__tests__/parse-inspiration.test.ts
git commit -m "feat(create): schema parity — required dates gate Generate; request types match backend"
```

---

### Task 3: Auth — passwordless email OTP sign-in + sign-out

**Files:**
- Modify: `frontend/app/sign-in/page.tsx` (full rewrite)
- Create: `frontend/components/auth/SignOutButton.tsx`
- Modify: `frontend/components/create/CreateTripFlow.tsx` (header: add SignOutButton + My trips link)

**Interfaces:**
- Consumes: `createClient()` from `frontend/lib/supabase/client.ts`.
- Produces: a signed-in Supabase session (cookie-based via @supabase/ssr) that Task 4's middleware gate and Task 5's `getAccessToken()` rely on. `SignOutButton` (default export, no props) reused by Task 6's trips list.

No unit tests for these UI components (repo has no component-test harness; pure libs only) — verified via Task 8 QA. Run `npm run typecheck` instead.

- [ ] **Step 1: Rewrite the sign-in page as a two-step email → code flow**

Replace `frontend/app/sign-in/page.tsx` entirely with:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function SignInPage() {
  const router = useRouter()
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function sendCode() {
    setPending(true); setError(null); setNotice(null)
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: true }, // signup and sign-in are the same flow
    })
    setPending(false)
    if (error) { setError(error.message); return }
    setStep('code')
    setNotice(`We sent a 6-digit code to ${email.trim()}.`)
  }

  async function verifyCode() {
    setPending(true); setError(null)
    const supabase = createClient()
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: code.trim(),
      type: 'email',
    })
    setPending(false)
    if (error) { setError('That code is invalid or expired. Check the digits or resend.'); return }
    router.push('/app') // middleware routes new users on to /app/onboarding
  }

  return (
    <main className="min-h-[100dvh] flex items-center justify-center bg-[color:var(--void)]">
      <div className="flex w-full max-w-sm flex-col items-center gap-8 p-6">
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-3xl font-[family-name:var(--font-instrument-serif)] text-[color:var(--starlight)] italic">
            Astrail
          </h1>
          <p className="text-sm text-[color:var(--starlight)]/50 font-[family-name:var(--font-geist)]">
            Turn travel Reels into a route you&apos;ll actually take.
          </p>
        </div>

        {step === 'email' ? (
          <form
            className="flex w-full flex-col gap-3"
            onSubmit={(e) => { e.preventDefault(); void sendCode() }}
          >
            <label htmlFor="email" className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)]">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="surface type-body rounded-lg p-2.5 text-sm text-[var(--starlight)] placeholder:text-[var(--faint)]"
            />
            <button
              type="submit"
              disabled={pending || !email.trim()}
              className="type-label rounded-xl border border-[var(--brass)] bg-[var(--brass-soft)] px-4 py-3 text-sm uppercase tracking-wide text-[var(--starlight)] disabled:opacity-40"
            >
              {pending ? 'Sending…' : 'Email me a code'}
            </button>
          </form>
        ) : (
          <form
            className="flex w-full flex-col gap-3"
            onSubmit={(e) => { e.preventDefault(); void verifyCode() }}
          >
            <label htmlFor="otp" className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)]">
              6-digit code
            </label>
            <input
              id="otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="123456"
              className="surface type-body rounded-lg p-2.5 text-center text-lg tracking-[0.4em] text-[var(--starlight)] placeholder:text-[var(--faint)]"
            />
            <button
              type="submit"
              disabled={pending || code.trim().length !== 6}
              className="type-label rounded-xl border border-[var(--brass)] bg-[var(--brass-soft)] px-4 py-3 text-sm uppercase tracking-wide text-[var(--starlight)] disabled:opacity-40"
            >
              {pending ? 'Verifying…' : 'Sign in'}
            </button>
            <button
              type="button"
              onClick={() => void sendCode()}
              disabled={pending}
              className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)] underline-offset-2 hover:underline disabled:opacity-40"
            >
              Resend code
            </button>
            <button
              type="button"
              onClick={() => { setStep('email'); setCode(''); setError(null); setNotice(null) }}
              className="type-label text-[11px] uppercase tracking-wide text-[var(--faint)] underline-offset-2 hover:underline"
            >
              Use a different email
            </button>
          </form>
        )}

        {notice ? <p className="type-body text-xs text-[var(--muted)]">{notice}</p> : null}
        {error ? <p className="type-body text-xs text-red-400" role="alert">{error}</p> : null}
      </div>
    </main>
  )
}
```

(The Google button and `GoogleIcon` are removed — Google OAuth is deferred post-beta. Keep `frontend/app/auth/callback/route.ts` untouched; it is unused by OTP but harmless and needed when OAuth returns.)

- [ ] **Step 2: Create the sign-out button**

Create `frontend/components/auth/SignOutButton.tsx`:

```tsx
'use client'

import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function SignOutButton() {
  const router = useRouter()
  async function signOut() {
    await createClient().auth.signOut()
    router.push('/sign-in')
  }
  return (
    <button
      type="button"
      onClick={() => void signOut()}
      className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)] underline-offset-2 hover:underline"
    >
      Sign out
    </button>
  )
}
```

- [ ] **Step 3: Mount it in the create-flow header**

In `frontend/components/create/CreateTripFlow.tsx`, add imports:

```tsx
import Link from 'next/link'
import SignOutButton from '@/components/auth/SignOutButton'
```

and replace the `<header>` block with:

```tsx
      <header className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <h1 className="type-display text-3xl text-[var(--starlight)]">Plan a new trip</h1>
          <div className="flex items-center gap-4">
            <Link
              href="/app/trips"
              className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)] underline-offset-2 hover:underline"
            >
              My trips
            </Link>
            <SignOutButton />
          </div>
        </div>
        <p className="type-body text-sm text-[var(--muted)]">
          Paste the Reels that inspired you, add any must-visit places, and Astrail maps the route you actually take.
        </p>
      </header>
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS (the `/app/trips` route arrives in Task 6 — Next typed-routes is not enabled, so a string href compiles).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/sign-in/page.tsx frontend/components/auth/SignOutButton.tsx frontend/components/create/CreateTripFlow.tsx
git commit -m "feat(auth): passwordless email OTP sign-in (6-digit code) + sign-out; Google deferred"
```

---

### Task 4: Onboarding — real profile save + gate

**Files:**
- Create: `frontend/lib/trip/supabase-api.ts`
- Modify: `frontend/components/onboarding/OnboardingWizard.tsx:5,39-44`
- Modify: `frontend/middleware.ts`

**Interfaces:**
- Consumes: `ProfileInput` from `frontend/lib/onboarding/onboarding.ts`; `TravelerProfile` from `backend-types.ts`; `createClient()`.
- Produces: `saveProfile(input: ProfileInput): Promise<TravelerProfile>` (upsert, sets `onboarding_completed: true`). Task 6 extends this same file with `getTrip`/`listTrips` — keep it one module, RLS-direct reads/writes live here.

- [ ] **Step 1: Create `frontend/lib/trip/supabase-api.ts`**

```typescript
// RLS-direct Supabase reads/writes (architecture: most reads skip the backend).
// Replaces mock-api for the real app; mock-api stays for offline shell/tests only.
import { createClient } from '@/lib/supabase/client'
import type { ProfileInput } from '@/lib/onboarding/onboarding'
import type { TravelerProfile } from '@/lib/trip/backend-types'

export async function saveProfile(input: ProfileInput): Promise<TravelerProfile> {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not signed in')
  // Upsert: the profile row may not exist yet (no auto-create trigger for traveler_profiles).
  const { data, error } = await supabase
    .from('traveler_profiles')
    .upsert({ id: user.id, ...input, onboarding_completed: true })
    .select('id,origin_city,travel_style_tags,preference_tags,preference_notes,onboarding_completed')
    .single()
  if (error) throw new Error(`Could not save your preferences: ${error.message}`)
  return data as TravelerProfile
}
```

- [ ] **Step 2: Swap the wizard's import and add error handling**

In `frontend/components/onboarding/OnboardingWizard.tsx`:

Line 5: `import { saveProfile } from '@/lib/trip/supabase-api'`

Add state next to `saving`:

```tsx
  const [saveError, setSaveError] = useState<string | null>(null)
```

Replace `finish()`:

```tsx
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
```

And render the error just above the nav buttons (inside the outer `<main>`, before the `mt-auto` div):

```tsx
      {saveError ? (
        <p className="type-body text-xs text-red-400" role="alert">{saveError}</p>
      ) : null}
```

- [ ] **Step 3: Gate un-onboarded users in the middleware**

In `frontend/middleware.ts`, after the existing `if (!user && ...)` redirect block (line 36-40), add:

```typescript
  // Onboarding gate: authenticated users must finish the wizard once before /app/*.
  // Missing profile row counts as not onboarded (no auto-create trigger for traveler_profiles).
  if (user && !request.nextUrl.pathname.startsWith('/app/onboarding')) {
    const { data: profile } = await supabase
      .from('traveler_profiles')
      .select('onboarding_completed')
      .eq('id', user.id)
      .maybeSingle()
    if (!profile?.onboarding_completed) {
      const url = request.nextUrl.clone()
      url.pathname = '/app/onboarding'
      return NextResponse.redirect(url)
    }
  }
```

- [ ] **Step 4: Typecheck + run frontend tests**

Run: `cd frontend && npm run typecheck && npm run test`
Expected: PASS (mock-api and its tests are untouched).

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/trip/supabase-api.ts frontend/components/onboarding/OnboardingWizard.tsx frontend/middleware.ts
git commit -m "feat(onboarding): persist wizard to traveler_profiles (RLS upsert) + middleware gate"
```

---

### Task 5: Create flow — real POST + live SSE stage events

**Files:**
- Create: `frontend/lib/supabase/session.ts`
- Modify: `frontend/lib/trip/api.ts` (add `streamGeneration`)
- Modify: `frontend/components/create/CreateTripFlow.tsx` (swap mock-api → real api)

**Interfaces:**
- Consumes: `generateTrip(req, accessToken)` and `streamTrip(tripId, accessToken)` from `api.ts` (existing, unchanged); `canGenerate(items, brief)` from Task 2.
- Produces: `getAccessToken(): Promise<string>`; `streamGeneration(tripId: string, accessToken: string, onEvent: (e: StreamEvent) => void, onReset?: () => void): { cancel: () => void }` — same `{ cancel }` handle shape the component already uses.

- [ ] **Step 1: Session token helper**

Create `frontend/lib/supabase/session.ts`:

```typescript
import { createClient } from './client'

export async function getAccessToken(): Promise<string> {
  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not signed in')
  return session.access_token
}
```

- [ ] **Step 2: EventSource wrapper in `frontend/lib/trip/api.ts`**

Append:

```typescript
import type { StreamEvent } from './backend-types'

// EventSource wrapper matching the mock streamGeneration's { cancel } handle.
// The backend replays ALL events on each (re)connection (per-connection seen-set),
// so onReset fires on every open — callers clear their event list there to
// avoid duplicates after an auto-reconnect.
export function streamGeneration(
  tripId: string,
  accessToken: string,
  onEvent: (e: StreamEvent) => void,
  onReset?: () => void,
): { cancel: () => void } {
  const es = streamTrip(tripId, accessToken)
  es.onopen = () => onReset?.()
  es.onmessage = (msg) => {
    if (msg.data === '[DONE]') {
      es.close()
      return
    }
    try {
      onEvent(JSON.parse(msg.data) as StreamEvent)
    } catch {
      // malformed line — skip (contract: heartbeat comments never reach onmessage)
    }
  }
  return { cancel: () => es.close() }
}
```

(`import type` lines merge with the existing one at the top of the file — end state has a single `import type { GenerateTripRequest, GenerateTripResponse, StreamEvent } from './backend-types'`.)

- [ ] **Step 3: Swap CreateTripFlow to the real API**

In `frontend/components/create/CreateTripFlow.tsx`:

Replace line 5 with:

```tsx
import { generateTrip, streamGeneration } from '@/lib/trip/api'
import { getAccessToken } from '@/lib/supabase/session'
```

Add state next to `events`:

```tsx
  const [submitError, setSubmitError] = useState<string | null>(null)
```

Replace `handleGenerate()`:

```tsx
  async function handleGenerate() {
    setPhase('generating')
    setEvents([])
    setSubmitError(null)
    try {
      const token = await getAccessToken()
      const { trip_id } = await generateTrip(toGenerateRequest(items, brief), token)
      if (!activeRef.current) return // unmounted during POST — do not start the stream
      handleRef.current = streamGeneration(
        trip_id,
        token,
        (event) => {
          if (!activeRef.current) return
          setEvents((prev) => [...prev, event])
          if (event.type === 'result') {
            handleRef.current?.cancel()
            router.push(`/app/trip/${tripIdFromResult(event.content, trip_id)}`)
          }
        },
        () => { if (activeRef.current) setEvents([]) },
      )
    } catch (err) {
      if (!activeRef.current) return
      setPhase('compose')
      setSubmitError(err instanceof Error ? err.message : 'Could not start generation.')
    }
  }
```

Render the error above the Generate button:

```tsx
      {submitError ? (
        <p className="type-body text-xs text-red-400" role="alert">{submitError}</p>
      ) : null}
```

Note: on a FAILED generation the backend still emits a terminal `result` event (`content` = `{"error": ...}`), so the user is navigated to the trip page, which shows the failed state (Task 6). That satisfies "explicit failed state, never a hang".

- [ ] **Step 4: Typecheck + tests**

Run: `cd frontend && npm run typecheck && npm run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/supabase/session.ts frontend/lib/trip/api.ts frontend/components/create/CreateTripFlow.tsx
git commit -m "feat(create): wire real generate-trip POST + live SSE stage events (mock-api retired from flow)"
```

---

### Task 6: Trip page + trips list on real data

**Files:**
- Modify: `frontend/lib/trip/supabase-api.ts` (add `getTrip`, `listTrips`)
- Modify: `frontend/components/trip/TripWorkspace.tsx:6` (+ status states)
- Create: `frontend/app/app/trips/page.tsx`
- Create: `frontend/components/trips/TripsList.tsx`

**Interfaces:**
- Consumes: `TripBundle`, `Trip` and row types from `backend-types.ts`; RLS select policies (verified to exist for every bundle table).
- Produces: `getTrip(tripId: string): Promise<TripBundle | null>` (same signature as mock-api's — TripWorkspace changes only its import); `listTrips(): Promise<Trip[]>`.

- [ ] **Step 1: Add the bundle + list reads to `frontend/lib/trip/supabase-api.ts`**

Extend the imports and append:

```typescript
import type {
  GenerationEvent, HotelSuggestion, RestaurantSuggestion, Trip, TripBundle,
  TripDay, TripInspirationItem, TripPlace, TransportLeg,
} from '@/lib/trip/backend-types'

export async function getTrip(tripId: string): Promise<TripBundle | null> {
  const supabase = createClient()
  const { data: trip, error } = await supabase
    .from('trips').select('*').eq('id', tripId).maybeSingle()
  if (error || !trip) return null // RLS: another user's trip reads as absent

  const [inspiration, places, days, legs, restaurants, hotels, events] = await Promise.all([
    supabase.from('trip_inspiration_items').select('*').eq('trip_id', tripId),
    supabase.from('trip_places').select('*, place:places(*)').eq('trip_id', tripId)
      .order('day_number').order('sort_order'),
    supabase.from('trip_days').select('*').eq('trip_id', tripId).order('day_number'),
    supabase.from('transport_legs').select('*').eq('trip_id', tripId).order('leg_order'),
    supabase.from('restaurant_suggestions').select('*').eq('trip_id', tripId),
    supabase.from('hotel_suggestions').select('*').eq('trip_id', tripId),
    supabase.from('generation_events').select('*').eq('trip_id', tripId)
      .order('created_at').order('id'),
  ])

  return {
    trip: trip as Trip,
    inspiration: (inspiration.data ?? []) as TripInspirationItem[],
    places: (places.data ?? []) as unknown as TripPlace[],
    days: (days.data ?? []) as TripDay[],
    transport_legs: (legs.data ?? []) as TransportLeg[],
    restaurants: (restaurants.data ?? []) as RestaurantSuggestion[],
    hotels: (hotels.data ?? []) as HotelSuggestion[],
    events: (events.data ?? []) as GenerationEvent[],
  }
}

export async function listTrips(): Promise<Trip[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from('trips').select('*').order('created_at', { ascending: false })
  if (error) throw new Error(`Could not load trips: ${error.message}`)
  return (data ?? []) as Trip[]
}
```

(Note: `trip_inspiration_items` is currently never populated by the backend — the array renders empty, which the components tolerate. `thumbnail_url` is a mock-only convenience field; absent key reads as `undefined`, which the tray only uses in the create flow anyway.)

- [ ] **Step 2: TripWorkspace — real read + failed/generating states**

In `frontend/components/trip/TripWorkspace.tsx`:

Line 6: `import { getTrip } from '@/lib/trip/supabase-api'`

After the `not_found` early-return block (line 66-72), add two status branches:

```tsx
  if (bundle.trip.status === 'failed') {
    return (
      <main className="flex h-[100dvh] flex-col items-center justify-center gap-3 bg-[var(--void)] p-6">
        <p className="type-display text-xl text-[var(--starlight)]">Generation failed</p>
        <p className="type-body max-w-md text-center text-sm text-[var(--muted)]">
          Astrail couldn&apos;t build this trip. Start a new one — repeat Reels are cached, so retrying is fast.
        </p>
        <a href="/app" className="type-label text-xs uppercase tracking-wide text-[var(--brass)] underline-offset-2 hover:underline">
          Plan a new trip
        </a>
      </main>
    )
  }
  if (bundle.trip.status === 'generating' || bundle.trip.status === 'draft') {
    return (
      <main className="flex h-[100dvh] flex-col items-center justify-center gap-3 bg-[var(--void)] p-6">
        <p className="type-label text-xs uppercase tracking-wide text-[var(--muted)]">
          Still generating — refresh in a moment.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="type-label text-xs uppercase tracking-wide text-[var(--brass)] underline-offset-2 hover:underline"
        >
          Refresh
        </button>
      </main>
    )
  }
```

(`places_ready`, `complete`, and `saved_with_gaps` fall through to the normal map view.)

- [ ] **Step 3: Trips list**

Create `frontend/components/trips/TripsList.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Trip } from '@/lib/trip/backend-types'
import { listTrips } from '@/lib/trip/supabase-api'
import SignOutButton from '@/components/auth/SignOutButton'

export default function TripsList() {
  const [trips, setTrips] = useState<Trip[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    listTrips()
      .then((t) => { if (active) setTrips(t) })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : 'Could not load trips.') })
    return () => { active = false }
  }, [])

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col gap-6 bg-[var(--void)] p-6">
      <header className="flex items-center justify-between">
        <h1 className="type-display text-3xl text-[var(--starlight)]">My trips</h1>
        <div className="flex items-center gap-4">
          <Link
            href="/app"
            className="type-label text-[11px] uppercase tracking-wide text-[var(--brass)] underline-offset-2 hover:underline"
          >
            New trip
          </Link>
          <SignOutButton />
        </div>
      </header>

      {error ? <p className="type-body text-xs text-red-400" role="alert">{error}</p> : null}
      {trips === null && !error ? (
        <p className="type-label text-xs uppercase tracking-wide text-[var(--muted)]">Loading…</p>
      ) : null}
      {trips !== null && trips.length === 0 ? (
        <p className="type-body text-sm text-[var(--muted)]">No trips yet — paste some Reels and generate your first one.</p>
      ) : null}

      <ul className="flex flex-col gap-3">
        {(trips ?? []).map((trip) => (
          <li key={trip.id}>
            <Link
              href={`/app/trip/${trip.id}`}
              className="surface flex flex-col gap-1 rounded-xl p-4 transition-opacity hover:opacity-90"
            >
              <span className="type-body text-sm text-[var(--starlight)]">
                {trip.title ?? trip.destination_hint ?? 'Untitled trip'}
              </span>
              <span className="type-label text-[10px] uppercase tracking-wide text-[var(--faint)]">
                {trip.start_date ?? '—'} → {trip.end_date ?? '—'} · {trip.status}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  )
}
```

Create `frontend/app/app/trips/page.tsx`:

```tsx
import TripsList from '@/components/trips/TripsList'

export default function TripsPage() {
  return <TripsList />
}
```

- [ ] **Step 4: Typecheck + tests**

Run: `cd frontend && npm run typecheck && npm run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/trip/supabase-api.ts frontend/components/trip/TripWorkspace.tsx frontend/components/trips/TripsList.tsx frontend/app/app/trips/page.tsx
git commit -m "feat(trip): real RLS-direct trip bundle + failed/generating states + trips list page"
```

---

### Task 7: Deploy-readiness — CORS env, .env.example, Supabase dashboard doc

**Files:**
- Modify: `backend/main.py:54-60` (CORS block only)
- Modify: `.env.example`
- Create: `docs/SUPABASE-SETUP.md`

**Interfaces:**
- Produces: `ALLOWED_ORIGINS` env var (comma-separated; default `*` preserves current local behavior).

- [ ] **Step 1: Env-configurable CORS**

In `backend/main.py`, add `import os` to the stdlib imports, then replace the middleware block:

```python
# CORS: comma-separated origins; default "*" keeps local dev friction-free.
# Deploy sets ALLOWED_ORIGINS=https://<vercel-domain> (see docs/SUPABASE-SETUP.md).
_allowed_origins = [
    o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

- [ ] **Step 2: Update `.env.example`**

In the backend section add:

```
# CORS — comma-separated allowed origins. Local: * . Prod: https://<vercel-domain>
ALLOWED_ORIGINS=*
```

In the frontend section, ensure this line exists with a comment:

```
# Real auth for the beta flow — mock auth must stay OFF
NEXT_PUBLIC_MOCK_AUTH=false
```

- [ ] **Step 3: Write `docs/SUPABASE-SETUP.md`**

```markdown
# Supabase dashboard setup — beta email OTP auth

One-time manual configuration (not in code). Do these in the Supabase project dashboard
before testing the beta sign-in flow.

## 1. Enable email OTP sign-in
Authentication → Providers → Email: **Enable** the provider.
No password requirements apply — the app uses `signInWithOtp` (passwordless).

## 2. Send a 6-digit code instead of a magic link
Authentication → Email Templates → **Magic Link**: replace the link with the token, e.g.

    <h2>Your Astrail sign-in code</h2>
    <p>Enter this code in the app:</p>
    <h1>{{ .Token }}</h1>
    <p>It expires in 10 minutes. If you didn't request it, ignore this email.</p>

(`{{ .Token }}` is the 6-digit OTP; when the template contains it, users get a code.)
Do the same for the **Sign Up / Confirm signup** template if your project version splits them.

## 3. Shorten OTP expiry
Authentication → Providers → Email → **Email OTP expiration**: set to `600` seconds (10 min).

## 4. Rate limits (know the ceiling)
Supabase's BUILT-IN mailer sends only a few emails per hour — fine for localhost testing
with 1–2 addresses, NOT fine for real beta users.
**Before inviting external users:** Project Settings → Auth → SMTP — configure custom SMTP
(e.g. Resend free tier) and raise Authentication → Rate Limits accordingly.

## 5. Redirect URLs (unchanged for OTP)
OTP verification happens in-app (`verifyOtp`) — no redirect URL config needed.
Keep the existing Site URL for deploys: Authentication → URL Configuration.
```

- [ ] **Step 4: Verify backend still boots + tests pass**

Run: `cd backend && uv run pytest -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/main.py .env.example docs/SUPABASE-SETUP.md
git commit -m "chore(deploy): env-configurable CORS + .env.example + Supabase OTP dashboard doc"
```

---

### Task 8: End-to-end verification (manual QA + cold acceptance run)

**Files:** none (verification only). Requires: both dev servers running, real Supabase project configured per `docs/SUPABASE-SETUP.md`, `OPENAI_API_KEY` + `APIFY_TOKEN` set, `NEXT_PUBLIC_MOCK_AUTH=false`.

- [ ] **Step 1: Start both servers**

```bash
# terminal 1
cd backend && uv run uvicorn main:app --reload
# terminal 2
cd frontend && npm run dev
```

- [ ] **Step 2: Auth checks (success criteria 1, 5-partial)**

1. Visit `http://localhost:3000/app` signed out → redirected to `/sign-in`.
2. Enter a fresh email → "Email me a code" → receive 6-digit code → enter wrong code → clear error shown → enter right code → land on `/app/onboarding` (gate fired: no profile row yet).
3. `curl -i http://localhost:8000/generate-trip -X POST -H "Content-Type: application/json" -d "{}"` → **401/403** (no token).

- [ ] **Step 3: Onboarding checks (criterion 2)**

1. Complete the 5-step wizard → row appears in `traveler_profiles` with `onboarding_completed=true` (check Supabase table editor).
2. Sign out → sign back in (same email, new code) → land directly on `/app` (gate skipped).

- [ ] **Step 4: COLD acceptance run (criterion 3 — fresh, uncached reels, full Apify)**

1. Pick 2 Instagram Reel URLs that have NEVER been run against this Supabase project (check `reel_cache` table is empty of them).
2. Paste both + dates + budget + origin + a per-trip note → Generate.
3. During generation: live stage events render (scrape → extract → dedup → narrate → weather/transport/restaurants/hotels/summarize → save).
4. On completion: auto-navigate to `/app/trip/[id]` — Mapbox map renders pins (source-colored), day selector works, route lines draw for `ok` legs, itinerary/restaurant/hotel panels populate, evidence quotes visible.

- [ ] **Step 5: Persistence + preference checks (criteria 4, 5)**

1. In Supabase: the trips row has `budget_level`, `origin_city`, and `preference_summary` containing BOTH profile tags ("Travel style: …") and the per-trip note ("This trip: …"); `preference_sources` = `{memory,explicit}`.
2. Refresh `/app/trip/[id]` → trip reloads from Supabase (no regeneration — `jobs` table unchanged).
3. `/app/trips` lists the trip; clicking opens it.
4. Sign in as a SECOND email in another browser profile → visiting the first user's trip URL shows "Trip not found" (RLS).
5. Sign out returns to `/sign-in` and `/app` is blocked again.

- [ ] **Step 6: Failure path (criterion 6)**

1. Temporarily set `APIFY_TOKEN=invalid` in backend env, restart backend, generate with a NEW (uncached) reel → stage events appear, then terminal failed result; browser lands on the trip page showing the "Generation failed" state (no hang; stream ended with `[DONE]` — verify in devtools Network tab).
2. Restore the real `APIFY_TOKEN`.

- [ ] **Step 7: Warm-path sanity (dev iteration mode)**

Re-run generation with the SAME reels from Step 4 → `cache_hit` stage event appears, run completes much faster, itinerary place order identical.

- [ ] **Step 8: Record results**

Append a `## QA evidence — YYYY-MM-DD` section to this plan file listing each step PASS/FAIL with notes; screenshots of the map view and the stage-event feed. Fix-forward any failures before final review.
