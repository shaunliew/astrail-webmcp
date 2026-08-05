# Plan — Trip-level feedback UI (one-shot composer: thumbs/stars + optional note)

> Status: **BUILT + FULLY REVIEWED (2026-08-05) — held pre-merge on the live /qa human gate.**
> Review trail: plan eng review + Codex r1 (5/10, 2 High blockers → composer redesign) → Codex r2
> (8/10, no blockers, 7 folds) → T1/T2/T3 built via subagent-driven-development, each per-task
> gate PASS with fault-injection (14 injections total, every guard proven load-bearing) → final
> fable whole-branch SHIP-WITH-NITS + Codex cross-model (both independently converged on the
> noted-send fingerprint hole) → fix `29a6fbd` + fix-delta re-review PASS. 521/521 frontend
> tests, tsc clean, `npm run build` clean, eval anchor holds. **Remaining (ZH):** accept/override
> the composer decision below; give the go for live /qa (permanent append-only rows, Aster demo
> account); then merge into `zh`. Owner: frontend (Zhi Hao's lane, built by an autonomous
> session). Base: branch `feat/trip-feedback-ui` off `zh`
> (`/Users/desmondchyezhihao/Github/astrail-zh`). Board card: *"Frontend: replace mock
> SettingsView with real data; add feedback UI + clipboard/PWA intake (PRD)"* — **feedback-UI half
> only**. Backend half (PR #54) is Done, deployed, verified live — this arc adds its first caller,
> which makes the PRD §18 / PRD:86 beta adoption metric start collecting.

## ⚠️ Decisions auto-made in this autonomous session (override at kickoff if wrong)

No user was present for the mandatory interview; ZH's pasted handoff + the repo's canonical
`HANDOFF.md` served as the brief. Two calls are ZH-overridable:

1. **Composer over instant-click thumbs.** A thumb press selects; "Send feedback" submits (2
   clicks for a bare thumbs verdict). Chosen because the backend was designed for "rating a trip
   is ONE request" (3/min burst budget), analytics take **latest-per-user across all types**
   (`main.py` route docstring — a later free_text row would displace a rating as "latest"), and
   `comment` is legal on rating/thumb rows, so the note travels WITH the signal it explains. The
   rejected alternative (each control fires its own POST) burns the rate budget, can 429 an
   honest correction, and can confirm contradictory signals simultaneously.
2. **Live-verify uses the Aster demo account** (`aster@astrail.app`) and needs ZH's go before any
   live POST: feedback is append-only with **no deletion endpoint**, so smoke rows are permanent
   production data. A QA row on a real account would become that user's "latest" analytics signal.

## Goal

Let a signed-in user submit one feedback action per press — a thumbs verdict, a 1–5 star rating
(either optionally carrying a note), or a bare text note — against the live
`POST /trips/{trip_id}/feedback`, on every trip state where feedback is meaningful (including
failed trips), without client-side 422s, without burning the 3/minute budget on a single opinion,
and with honest pending/error states.

## Contract (verified in code this session — do not re-derive)

- Route: `backend/main.py:419+` — `@limiter.limit(BURST_LIMIT)` (`backend/rate_limit.py:32`,
  default `3/minute`), `trip_id: UUID` (malformed → 422). Ownership → **404, never 403**.
  **Owner check is app-code, NOT RLS** — the backend connects as service_role, which bypasses
  every RLS policy; `feedback_insert_own_trip` is a backstop for a future direct-from-frontend
  path only (route docstring). 201 body is built from the persisted row.
- Schema: `backend/api/schemas.py:187-217` + `extra="forbid"` wrapper `_TripFeedbackRequest`
  (`main.py:252`). `rating` int 1–5 **strict**, required iff `feedback_type == "rating"`,
  forbidden otherwise. `comment` ≤2000, required non-whitespace for `correction`/`free_text`,
  **allowed (optional) on rating/thumbs rows** — this is what makes the one-request composer
  legal. Never send `artifact_type`/`artifact_id`/`user_id`.
- Append-only, no GET endpoint, analytics latest-per-user. Failed trips accept feedback
  deliberately (`backend/test_main.py` `test_feedback_is_accepted_on_a_failed_trip` — "the most
  valuable beta signal").
- TS mirrors exist at `frontend/lib/trip/backend-types.ts:305-330` — import, don't rewrite. The
  mirror `TripFeedbackRequest` stays untouched (schema parity, guardrail #4); a narrower
  client-side draft union is additive (T1).
- Auth: bearer via `getAccessToken()` (`frontend/lib/supabase/session.ts:6-12`, throws
  `'Not signed in'` when sessionless). Identity from the token only (guardrail #5).

## Status matrix (Codex r1 High #1 — this is now explicit, and tested)

| trip.status | Where the user is | Feedback panel |
|---|---|---|
| `complete` | normal workspace | **shown** (bottom of details panel) |
| `saved_with_gaps` | normal workspace | **shown** (partial success is exactly what to ask about) |
| `failed` | failed early-return screen | **shown** (mounted under the failure copy — HANDOFF.md: "don't hide the UI on failures") |
| `places_ready` | normal workspace (falls through!) | **hidden** (mid-pipeline; explicit allowlist, not "whatever reaches the main return") |
| `generating` / `draft` | generating early-return | hidden |

## Non-goals (each with its trigger)

- `correction` type UI + artifact-level feedback → the artifact-feedback arc.
- Cross-session "you already rated" seeding → when a GET feedback endpoint exists (HANDOFF.md
  offers it on request).
- SettingsView mock replacement (branch `fix/settings-live-mem0` exists) and clipboard/PWA intake
  → separate halves of the board card. Don't touch settings files.
- Toast system, optimistic UI, client-side rate-limit counter, Retry-After parsing → single-flight
  lock + honest 429 copy is the feasible-first version.
- `authedPost()` DRY extraction across api.ts → TODOS.md entry (added 2026-08-05); this arc copies
  the house pattern.

## Tasks

### T1 — API seam: draft union + `submitTripFeedback` + mock-auth coverage + kill the stale stub

**Files:** `frontend/lib/trip/api.ts` (add), `frontend/lib/trip/mock-api.ts` (delete stub),
`frontend/lib/trip/__tests__/mock-api.test.ts` (drop stub's test),
`frontend/lib/trip/__tests__/trip-feedback-api.test.ts` (new),
`frontend/lib/trip/__tests__/trip-feedback-mock-auth.test.ts` (new),
`frontend/components/map/__tests__/relight.test.tsx` (one-line mock repair).

Add to `api.ts` (imports `TripFeedbackRequest`, `TripFeedbackResponse` from `./backend-types`):

```ts
// Client-side draft union (Codex r1 #7): narrower than the TripFeedbackRequest mirror (which
// stays 1:1 with the Pydantic model — guardrail #4), so the combinations the backend 422s
// (rating without a rating value, rating on a thumbs row) are unrepresentable at the call site.
// Every member is assignable to TripFeedbackRequest.
export type TripFeedbackDraft =
  | { feedback_type: 'thumbs_up' | 'thumbs_down'; comment?: string }
  | { feedback_type: 'rating'; rating: 1 | 2 | 3 | 4 | 5; comment?: string }
  | { feedback_type: 'free_text'; comment: string }

// Deterministic id for the mock-auth shell — no wall-clock, no randomness.
const MOCK_FEEDBACK_ID = 'mock-feedback-1'

// POST /trips/{tripId}/feedback — append-only trip-level feedback, ONE request per user action
// (a thumbs/rating signal may carry the note in the same row; backend allows optional comment
// there). Strict cross-field 422s live behind the draft union; ownership is 404-not-403; 429 =
// BURST_LIMIT (3/min default). Resubmission inserts a new row by design (analytics take
// latest-per-user), so callers may POST again to change a verdict.
export async function submitTripFeedback(
  tripId: string,
  req: TripFeedbackDraft,
  accessToken: string
): Promise<TripFeedbackResponse> {
  // Mock-auth shell: no backend — echo a deterministic persisted-row shape (mirrors requestSeat).
  if (MOCK_AUTH_ENABLED) {
    return {
      feedback: {
        id: MOCK_FEEDBACK_ID,
        trip_id: tripId,
        artifact_type: 'trip',
        feedback_type: req.feedback_type,
        rating: 'rating' in req ? req.rating : null,
        comment: req.comment ?? null,
      },
    }
  }
  const res = await fetch(`${BACKEND_URL}/trips/${tripId}/feedback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(req),
  })

  if (!res.ok) {
    throw await apiErrorFrom(res)
  }

  return res.json()
}
```

Delete `FeedbackInput` + `submitFeedback` from `mock-api.ts` and their test block in
`mock-api.test.ts` (stub predates the contract; only its own test imports it — verify with
`git grep -n "submitFeedback\|FeedbackInput"` before deleting). Add `submitTripFeedback: vi.fn()`
to the partial api mock in `relight.test.tsx:35` (it renders TripWorkspace with a two-export
mock; once the workspace imports the panel, the absent export is latent fragility — Codex r1 #5).

**Tests** (`trip-feedback-api.test.ts`, mirror `account-deletion-api.test.ts`):

1. Posts to `${BACKEND_URL}/trips/<id>/feedback` with `Authorization: Bearer <token>` +
   `Content-Type: application/json`.
2. **Exact body keys per variant**: bare thumbs → `Object.keys(body)` strictly
   `['feedback_type']`; thumbs+note → exactly `['feedback_type','comment']`; rating+note →
   exactly `['feedback_type','rating','comment']` with `typeof body.rating === 'number'`;
   free_text → exactly `['feedback_type','comment']`. *(Red if the helper pads keys —
   `extra="forbid"` upstream makes padding a 422.)*
3. 201 → resolves to the parsed `TripFeedbackResponse`.
4. Non-ok JSON envelope (`rate_limited`) → `ApiError` with `status: 429`, `code: 'rate_limited'`.
5. Non-ok non-JSON body → `ApiError(status, 'unknown', statusText)`.

**Tests** (`trip-feedback-mock-auth.test.ts`, mirror `account-deletion-mock-auth.test.ts` — Codex
r1 #5: the mock branch must not be able to regress with a green suite): under mock-auth, resolves
to the deterministic row (id `mock-feedback-1`, echoes trip_id/type/rating/comment) and **fetch is
never called**.

**Verify:** `cd frontend && npx vitest run lib/trip components/map` green; `npx tsc --noEmit`.
**Commit:** `feat(feedback): submitTripFeedback seam + draft union; drop the stale pre-contract mock stub`

### T2 — `TripFeedbackPanel` composer component

**Files:** `frontend/components/trip/TripFeedbackPanel.tsx` (new),
`frontend/components/trip/__tests__/TripFeedbackPanel.test.tsx` (new).

Props `{ tripId: string }` (the CALLER passes `bundle.trip.id`, never the route param — Codex r1
#4). One submission = one POST:

```
Composer state:
  signal: 'thumbs_up' | 'thumbs_down' | { rating: 1..5 } | null   (mutually exclusive —
           picking a star clears a thumb and vice versa; tapping the active thumb clears it)
  note:   string (textarea, maxLength 2000)
  confirmed: the LAST PERSISTED ROW (from the 201 body, never the request), rendered as a
             persistent SEMANTIC line under the controls — "Saved: thumbs down" / "Saved:
             4 of 5" (+ " with note" when the row has a comment). Codex r2 #5: tests assert
             this text, never class names.
  lastSent: string | null — fingerprint (JSON.stringify) of the last SUCCESSFULLY submitted
            draft. Codex r2 #1: success keeps the signal selected, so without this an
            unchanged second press would insert an identical permanent row and burn a
            rate-limit slot. Cleared implicitly by any edit (different fingerprint).
  pending (state, disables UI) + inFlight (ref, the synchronous single-flight guard)
  status: idle | sending('Sending…') | ok('Noted — thanks.') | error(message)

buildDraft(signal, note): EXPORTED pure helper, unit-tested directly. (T2 review correction:
  the Send predicate derives from `buildDraft(...) !== null`, so there is ONE physical guard
  with two tests over it — removing the builder guard reddens both. That is double coverage,
  not the BUILD-LOOP §7 trap this note originally warned about; kept for the record.)
Send enabled ⟺ !pending && draft !== null && fingerprint(draft) !== lastSent
Draft built at submit time:
  signal=thumb   → { feedback_type: thumb, ...(note.trim() && { comment: note.trim() }) }
  signal=rating  → { feedback_type: 'rating', rating: n, ...(note.trim() && { comment: note.trim() }) }
  signal=null    → { feedback_type: 'free_text', comment: note.trim() } (null when trim empty)
```

```ts
const inFlight = useRef(false)  // synchronous guard; `pending` state only styles/disables the UI

async function send() {
  if (inFlight.current) return
  const draft = buildDraft(signal, note)      // pure helper above the component; null when nothing to send
  if (!draft) return
  inFlight.current = true
  setPending(true)
  setStatus({ kind: 'sending', message: 'Sending…' })   // clears a stale "Noted — thanks." honestly
  let token: string
  try {
    token = await getAccessToken()
  } catch {
    // getAccessToken throws only when there is no session (session.ts:10).
    setStatus({ kind: 'error', message: 'Your session expired — sign in again.' })
    inFlight.current = false
    setPending(false)
    return
  }
  try {
    const { feedback } = await submitTripFeedback(tripId, draft, token)
    // Trust the persisted row, not the request we sent (the 201 echoes what was stored).
    setConfirmed(confirmedFromRow(feedback))
    setLastSent(JSON.stringify(draft))   // no-op-resubmission guard (Codex r2 #1)
    setNote('')
    setStatus({ kind: 'ok', message: 'Noted — thanks.' })
  } catch (err) {
    const message = err instanceof ApiError && err.status === 429
      ? 'Feedback is limited to a few sends a minute — give it a moment.'
      : err instanceof ApiError && err.status === 401
        ? 'Your session expired — sign in again.'
        : 'Couldn\'t send that. Try again.'
    setStatus({ kind: 'error', message })    // note + signal selection both survive errors
  } finally {
    inFlight.current = false
    setPending(false)
  }
}
```

Chrome (house tokens): thumbs = two pill buttons with hand-rolled thumb SVGs (one path, second
rotated 180°), `aria-pressed` from **selection**; stars = a `role="radiogroup"`
(`aria-label="Rate this trail"`) of five `role="radio"` buttons with `aria-checked` from
selection, built from `([1, 2, 3, 4, 5] as const).map(...)` — the `as const` keeps `n` in the
draft union's `1|2|3|4|5`, and radio semantics are the accessible shape for a pick-one scale
(Codex r2 #3); note textarea placeholder "Wrong place, bad route, missing gem — tell us." ; Send
button text "Send feedback" → "Sending…" while pending, `aria-busy={pending}` on the panel root
(honest pending — Codex r1 #6); status line `<p role="status">`; the confirmed row renders the
persistent "Saved: …" line described above. Active fill `bg-[var(--brass-soft)]
text-[var(--brass-bright)]`, muted default `text-[var(--muted)]`, `type-label` micro-labels —
match `segClass` / `SettingsView` tone.

**Tests** (RTL + vitest; partial-mock `@/lib/trip/api` via `importOriginal` **keeping the real
`ApiError`** — the SettingsView.test.tsx:17 house pattern, otherwise `instanceof` branches are
untestable; mock `@/lib/supabase/session`). Each names what makes it red:

1. Thumb select alone does NOT post (`submitTripFeedback` not called until Send). *(Red if
   instant-submit sneaks back in — the one-request semantics depend on this.)*
2. Thumb + Send → called once with exactly `{ feedback_type: 'thumbs_up' }`; with a note typed →
   exactly `{ feedback_type: 'thumbs_up', comment: <trimmed> }`. Thumbs-down symmetric. *(Red if
   keys pad or the note detaches from the signal row.)*
3. Star 4 + Send → `{ feedback_type: 'rating', rating: 4 }`, `typeof rating === 'number'`.
   Mutual exclusion BOTH directions + rating switch (Codex r2 #4): star 4 after thumbs-up clears
   the thumb; thumbs-up after star 4 clears the star (`aria-checked` false); star 2 after star 4
   moves the checked radio — in each case the next posted draft carries only the final signal.
   *(Red if exclusion is one-directional.)*
4. No signal + note → `{ feedback_type: 'free_text', comment: <trimmed> }`. No signal +
   whitespace note → Send disabled, no call *(red if the button predicate goes)*. **Plus direct
   `buildDraft` unit tests** (Codex r2 test-audit — one test per guard, BUILD-LOOP §7):
   `buildDraft(null, '   ')` → `null`; `buildDraft('thumbs_up', '  x  ')` →
   `{feedback_type:'thumbs_up', comment:'x'}`; `buildDraft(null, '')` → `null`. *(Red if only the
   BUILDER's trim/null guard is removed — the component-level test cannot see that.)*
5. Success clears the note; **429 rejection keeps note AND signal selection** and shows the
   rate-limit copy. *(Seed 'the route was wrong'; assert textarea + aria-pressed unchanged after
   rejection.)*
6. Confirmed-from-persisted-row, contradictory response (Codex r1 #3): submit thumbs_up, mock
   resolves with a row whose `feedback_type` is `'thumbs_down'` → the **"Saved: …" line** says
   thumbs down (semantic text assertion, not a class). *(The only assertion an
   update-from-request implementation cannot pass.)*
6b. No-op resubmission guard (Codex r2 #1): after a successful thumbs-up send, Send is disabled
   while the draft is unchanged; typing a note (or switching signal) re-enables it; the next send
   posts the NEW draft. *(Red if the `lastSent` fingerprint is removed — the button would light
   up for an identical row.)*
7. Single-flight, both layers: (a) hanging promise → controls + Send `disabled`, Send reads
   "Sending…", panel `aria-busy` *(red if pending state drops — honest-pending is load-bearing)*;
   (b) **two clicks on Send dispatched in the same act() batch → exactly one call** *(red if the
   `inFlight` ref goes — disabled state can't stop a same-frame second click; fault-inject by
   removing the ref to prove it)*.
8. Session-expired at token acquisition: `getAccessToken` rejects → sign-in copy,
   `submitTripFeedback` never called. 401 mid-flight (`ApiError(401,...)` from the API mock) →
   same copy. *(Red if either branch collapses into the generic message.)*
9. Network failure (`TypeError`) → generic copy, prior confirmed state + note unchanged. *(Red if
   the catch narrows to ApiError.)*

**Verify:** `npx vitest run components/trip` green; `npx tsc --noEmit`.
**Commit:** `feat(feedback): TripFeedbackPanel — one-shot composer (signal + optional note, single POST)`

### T3 — Mount per the status matrix

**Files:** `frontend/components/trip/TripWorkspace.tsx` (import + two mount points),
`frontend/components/trip/__tests__/TripWorkspace.test.tsx` (extend).

1. Normal workspace return — after the "How Astrail built this" section, gated by the explicit
   allowlist (NOT by reachability):

```tsx
{(bundle.trip.status === 'complete' || bundle.trip.status === 'saved_with_gaps') && (
  <Section title="How was this trail?">
    <TripFeedbackPanel key={bundle.trip.id} tripId={bundle.trip.id} />
  </Section>
)}
```

2. Failed early-return screen (`bundle.trip.status === 'failed'` block) — under the existing
   failure copy + "Plan a new trip" link, add a lead-in line ("Tell us what went wrong — it's the
   most useful feedback we get.") and the panel **inside a `w-full max-w-md` wrapper**, and make
   the failed screen scroll instead of rigidly centering (`overflow-y-auto` on the main; the
   current `h-[100dvh] justify-center` flex would clip the composer on short/mobile viewports
   with the keyboard open — Codex r2 #2):

```tsx
<div className="w-full max-w-md">
  <TripFeedbackPanel key={bundle.trip.id} tripId={bundle.trip.id} />
</div>
```

`bundle.trip.id` + `key` (Codex r1 #4): feedback binds to the LOADED trip, and panel state resets
on a trip-to-trip route transition instead of leaking a selection across trips.

Theming note (verified in globals.css): `--line`/`--muted`/`--brass-*`/`--starlight` are defined
at `:root` (night values) and re-mapped by `.paper-scope` (globals.css:543). The workspace mount
sits inside the paper-scope aside; the failed-screen mount inherits night tokens from `:root`.
Both are correct — do NOT wrap the failed-screen mount in `paper-scope`.

**Tests** (extend TripWorkspace.test.tsx; mock `TripFeedbackPanel` to a stamp that renders its
received `tripId`, keeping the suite's existing api mocks valid): status matrix — **all six
statuses** (Codex r2 #4): `complete` → panel present (override the fixture's status; TOKYO_TRIP
itself is NOT `complete`), `saved_with_gaps` → present, `places_ready` → **absent**, `failed` →
present on the failed screen, `generating` → absent, `draft` → absent. Plus: the stamp received
`bundle.trip.id` — seed a bundle whose trip.id DIFFERS from the route param to prove which one
flows (Codex r1 low). Key-reset (Codex r2 #4): in the TripFeedbackPanel suite, render with
`key`/trip A, set a signal, re-render keyed to trip B → selection is cleared (asserts the actual
reset behavior, not just the prop).

**Verify:** full `cd frontend && npm test` green; `npm run build`; `git diff --stat` sanity
(format-on-save trap). Backend ritual: `cd backend && uv run pytest evals/ -q` (frontend-only arc;
anchor must not move).
**Commit:** `feat(feedback): mount the feedback composer per the trip-status matrix (incl. failed trips)`

## Review + verification plan

- Per-task gate: `astrail-reviewer` (sonnet), fault-injecting the named guards (ref lock, trim
  guard, mutual exclusion, confirmed-from-row, status allowlist).
- Final: `astrail-reviewer` (fable) whole-branch **AND** gstack `/review` Codex cross-model —
  both. Deployment reality for the prompts: backend live at 3/min burst, strict 422s, 404-not-403,
  append-only with no delete; UI ships unflagged on zh's next deploy.
- Live-verify (needs ZH's go — permanent rows): Aster demo account, one composer submission per
  shape (thumb, rating+note, bare note) **with ≥60s between each** — the limiter allows THREE posts
  per window (the FOURTH 429s: Codex r2 #7), so three shape-smokes fit the budget and don't self-429;
  the spacing is good hygiene (each smoke lands in a fresh window, clear of the 429 probe below).
  Confirm 201s + rows in Supabase. Then, in a FRESH minute: one deliberate 422 (rating on a thumbs
  row via curl, not the UI — 422s don't write) and, last, the 429 probe (4 rapid sends). gstack
  `/qa` for flow evidence; if browser/creds unavailable, /qa is the held human gate (hotel-arc precedent).

## Rollback

Pure additive frontend; no flag, no schema change. Revert = drop the branch / revert the merge
commit. Note: live-verify rows are permanent (append-only, no delete endpoint) — that is why
live-verify is gated on ZH's go, not part of rollback.

## Kickstart prompt (for the implement phase)

> Use superpowers:subagent-driven-development. Read `.claude/CLAUDE.md`. Execute
> `docs/superpowers/plans/2026-08-05-trip-feedback-ui.md` (Rev 3) task-by-task on branch
> `feat/trip-feedback-ui` in `/Users/desmondchyezhihao/Github/astrail-zh`. `astrail-developer`
> (opus) implements each task; `astrail-reviewer` (sonnet) gates each; reviewers fault-inject the
> named guards. Do not expand scope.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | CLEAR | r1: 5/10, 2 High blockers (status matrix, one-action semantics) + 6 Medium/Low → redesign; r2: **8/10, BLOCKERS: none**, 7 non-blocking → all folded (Rev 3) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 3 issues (ref single-flight, 401 branch, token try/catch) folded pre-Codex; 10 total across rounds, 0 critical gaps open |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** r1 forced the composer redesign (single POST per action; failed-trip mount;
  places_ready excluded); r2 confirmed both blockers resolved and returned only
  implementation-level corrections, all folded into Rev 3.
- **CROSS-MODEL:** No standing tension. Claude's pre-Codex folds (ref lock, 401, token
  acquisition) were independently endorsed by Codex r2's test audit ("the same-act() double-click
  test can fail as claimed"). The one disagreement (three independent controls vs one-shot
  composer) was resolved IN CODEX'S FAVOR after code verification (latest-per-user analytics
  index + "rating a trip is ONE request" in the backend plan).
- **VERDICT:** ENG + CODEX CLEARED — ready to implement (Rev 3). Session was autonomous: the
  discovery interview could not run; decisions are documented in the ⚠️ section and listed
  below for ZH.

**UNRESOLVED DECISIONS:**
- Composer (2 clicks for a bare thumbs verdict) vs instant-click thumbs — auto-decided COMPOSER
  for contract/analytics alignment; ZH may override at kickoff before T2 ships.
- Live-verify writes permanent production feedback rows (append-only, no delete endpoint) —
  HELD for ZH's explicit go; will use the Aster demo account with cooldown sequencing.
