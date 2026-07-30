# Plan — Inspiration Trays + Library (frontend)

> Status: DRAFT (pending gstack `/plan-design-review` + Codex)
> Date: 2026-07-30 · Owner: Zhi Hao (frontend) · Lane: frontend-only
> Source of truth for design: the in-conversation discovery interview on 2026-07-30
> (sketches + references `06/08/014/015_*.PNG` under `frontend/reference/yaay-corefeature/`).
> Memory: [[inspiration-trays-feature]].

## 1. Why (problem)

Saved reels today are a flat, throwaway inbox: you capture reels, then a transient
"organize → select → plan" wizard turns some into a trip. There is no durable place to
**organize inspiration**, and the home has **two redundant surfaces**:

1. The flat **"Saved Reels"** strip (`DashboardHome`) — a raw inbox with no curation.
2. **"Your trails"** grid (`DashboardHome`) — duplicates the left-nav **Trails** route
   (`/app/trips` → `TripsList`); both list generated trips and both go to the map.

This feature gives reels a purpose *between* capture and generation — durable, named
**Trays** ("Tokyo winter 2026", "Korea Myeongdong") — and collapses the redundancy.

## 2. What (surfaces)

The `/app` home stops being an inbox and becomes a **Trays screen**:

1. **Library banner** — a rectangle "Your inspiration starts here". Tap → **Library panel**.
2. **Library panel** (new) — "Your saved reels lives here": **country filter chips + search**
   on top, a **card-fan carousel** of every saved reel below. Tap a reel → **Reel-info card**.
3. **Your trays** — a grid of **folder cards** (`components/ui/folder-gallery.tsx`, built
   earlier this session) per user collection, plus a **`+` create tile**.
4. **Reel-info card** (new, LEAN) — reuses the map pin-detail *look* (`014/015_*.PNG`). A reel
   contains place(s): show cover + each place (name, country, `evidence_quote`, Source Reel)
   + an **Add to tray** action.
5. **Create-tray flow** (`+`) — card-fan picker of reels (country-filtered) → name → create.
6. **Tray detail** — open a tray → its reels + **Create trail** → existing generate pipeline.
7. **Nav** — left-nav **Trails** (`TripsList`) stays as generated maps; home duplication removed.

## 3. Data model (already exists — unwired)

From `supabase/migrations/20260718120000_saved_reels_foundation.sql`:

- `reel_collections` (`id, user_id, name [1–80], sort_order, created_at, updated_at`).
- `reel_collection_items` (`collection_id, saved_reel_id`, PK both) — the reel↔tray join.
- **RLS + grants to `authenticated`** for select/insert/update/delete → the **frontend can
  CRUD directly via the Supabase client**, exactly like `lib/trip/supabase-api.ts` does for
  `trips`. **No backend endpoint, no migration for v1.**

Types already present in `lib/reels/backend-types.ts`: `ReelCollection`, `ReelCollectionItem`.

- **Library** = all `saved_reel_cards` for the user (existing `lib/reels/api.ts#listSavedReelCards`).
  No membership rows — every reel is inherently in the Library.
- **Many-to-many** — a reel is always in the Library and in **any number** of trays.

## 4. Non-goals / deferrals (with triggers)

| Deferred | Why / trigger |
|---|---|
| Collection **description / AI auto-add / public-private visibility** (the `08_*.PNG` form fields) | `reel_collections` has only `name, sort_order`. Needs a **migration** (backend/Shaun). v1 = name-only. |
| **Public collections / sharing** | A whole discovery/social surface. v2. Distinct from the deferral below. |
| **Instagram saved-collection import** | Explicit PRD non-goal (§100, §217, §1235). Our trays are *internal, user-created* — NOT IG import. Called out so review doesn't conflate them. |
| Reel-info **place_type badge, prose description, "mentioned in", reviews, mark-visited, directions, zoom-to-pin** | Data not in `saved_reel_cards` yet (no `place_type`, no per-place description; "mentioned in" needs a place→reels cross-index / other-user data). Grows as the enrich pipeline fills in. |
| **City-level** trays/filter ("Tokyo" vs "Japan") | Place proof carries `country_code` only, not locality. Country filter now; city later (needs a place city field or reverse-geocode). |
| Reel **thumbnails** | `thumbnail_url` is null in current data → **placeholder tiles** everywhere until backend populates it. Not a blocker; the components already fall back. |

## 5. Reconciliation with existing concepts

- PRD **"Inspiration Tray"** (§143) = the *transient per-trip input surface*. Our **Trays** are
  its **persistent, named** evolution — durable collections you curate and re-generate from.
  The transient organize wizard (`OrganizeGlobe` → `CountryTrays` → brief) is **reused** as the
  place-selection step of Create-trail (§Phase 3), not deleted.
- `SavedReelsFlow` (the `/app` inbox flow) keeps owning reel capture/organize + the generate
  path; only its **inbox phase** swaps `DashboardHome` → the new Trays screen.

## 6. Constraints to honor

- **≤5 places per generated trip** — `SavedReelsFlow` `MAX_PLACES = 5`, backend
  `api/schemas.py max_length=5`. Create-trail from a tray MUST route through place selection
  (reuse `CountryTrays`), never one-shot a tray with >5 places.
- Auth/RLS/owner: all collection reads/writes are RLS-scoped to `auth.uid()`; no anonymous
  access. No app-code owner check needed beyond RLS (guardrail #6), but every query is
  `user_id`-scoped by RLS automatically.
- Accent = **brass** (paper system); the mockups' pink predates it. No pink.
- No new deps beyond `motion` (already added this session).

---

## Phase 1 — Trays foundation + Library panel + nav cleanup

**Goal:** the home is the Trays screen; trays are real (create/list/open); Library browses all
reels with filter + search. No trip generation yet.

### T1.1 — Collections data layer (direct Supabase client)
- **New** `frontend/lib/reels/collections.ts` — mirror `lib/trip/supabase-api.ts`:
  - `listCollections(): Promise<ReelCollection[]>` — `from('reel_collections').select('*').order('sort_order').order('created_at')`.
  - `createCollection(name: string): Promise<ReelCollection>` — insert `{ name }` (user_id from RLS default / auth); return the row.
  - `renameCollection(id, name)`, `deleteCollection(id)`.
  - `addReelsToCollection(collectionId, savedReelIds[])` — insert rows into `reel_collection_items`
    with `user_id` set (see below). The junction has **no authenticated UPDATE grant**
    (migration:92), so use plain `insert` with **`ignoreDuplicates: true` on the PK conflict
    `(collection_id, saved_reel_id)` ONLY** — never a merge-`upsert`. A duplicate membership
    (Postgres `23505`) is a no-op; **every other error (RLS `with check`, FK, network) MUST
    surface**, not be swallowed.
  - `removeReelFromCollection(collectionId, savedReelId)`.
  - `listCollectionItems(): Promise<ReelCollectionItem[]>` OR `getCollectionReelIds(collectionId): Promise<string[]>`.
  - A grouped read for the trays grid: fetch all items once, group `saved_reel_id` by `collection_id` client-side (avoid N+1).
- **REQUIRED — set `user_id` explicitly on every insert** into BOTH `reel_collections` and
  `reel_collection_items`. Confirmed against the migration (lines 31–53): `user_id uuid not
  null` (NO default) + INSERT policy `reel_collections_insert_own` `with check (auth.uid() =
  user_id)`; `reel_collection_items.user_id` is also `not null` with composite FKs
  `(user_id, collection_id)` / `(user_id, saved_reel_id)` — so an item's `user_id` must equal
  the current uid AND match the owning collection + reel. Fetch
  `const { data } = await supabase.auth.getUser()` once and pass `user_id: data.user!.id` on
  every insert. Omitting it → not-null violation / RLS `with check` rejection (silent-fail risk).
- **Tests** `lib/reels/__tests__/collections.test.ts` — mock the supabase client; assert each
  call shape + duplicate-insert is swallowed.

### T1.2 — Trays screen (replaces the DashboardHome body)
- **New** `frontend/components/reels/TraysScreen.tsx` — props
  `{ cards, onCapture, onOrganize }` (SAME callback contract `DashboardHome` has today —
  `DashboardHome` is the ONLY caller of `onOrganize`/`onCapture`, so TraysScreen MUST carry
  them or the capture→organize→generate journey dies). Owns all collections state (single
  source of truth: list, memberships, loading/error, refresh after create/add/remove/rename/
  delete); fetches collections via T1.1.
  - Greeting + quick-capture form (lift from `DashboardHome` — keep capture working).
  - **Library banner** — rectangle, "Your inspiration starts here", opens the Library panel.
  - **Your trays** — grid of `FolderGallery` folders (one per collection, photos = that
    collection's reel thumbnails, `folderName = collection.name`) + a **`+` create tile**.
  - Empty state when no reels AND no trays (reuse `DashboardHome`'s copy).
- **Modify** `components/reels/SavedReelsFlow.tsx` — inbox phase renders `TraysScreen`
  instead of `DashboardHome`. **Delete** the "Saved Reels" strip + "Your trails" grid usage.
- **Deprecate** `DashboardHome.tsx`: delete it once `TraysScreen` carries `onCapture` +
  `onOrganize` and the organize/select entry is preserved (see the DECISION below). Migrate its
  capture form + empty-state + status-label coverage into TraysScreen's test — don't just drop
  it. (No "doubled greeting" bug: the code renders `full_name` once; that user's account value
  is literally doubled — a data artifact, not a code fix.)
- **Tests** `components/reels/__tests__/TraysScreen.test.tsx` — renders trays from collections,
  shows the `+` tile, shows the Library banner; empty state. Update/remove `DashboardHome.test.tsx`.
  **Also update `components/reels/__tests__/SavedReelsFlow.test.tsx:34`** — it `vi.mock`s
  `@/components/dashboard/DashboardHome`; swap that mock to `TraysScreen` or the SavedReelsFlow
  test breaks the moment DashboardHome is deleted. (Confirmed: only `SavedReelsFlow.tsx:15/260`
  imports DashboardHome in production — deletion is otherwise safe.)

### T1.3 — Library panel
- **New** `frontend/components/reels/LibraryPanel.tsx` — `{ cards, onClose, onOpenReel, onOrganize }`.
  - **[DECISION B] Multi-select mode → `onOrganize`** — the Library hosts the preserved
    select→organize action (same callback DashboardHome used, respecting `MAX_PLACES=5`), so the
    plan-from-selected-reels journey survives P1/P2. P3 removes it once tray→trail is primary.
  - Header "Your saved reels lives here" + **country filter chips** (derive the set from
    `cards[].places[].country_code`; `All` + one chip per present country) + a **search box**
    (client-side match on `caption`/`personal_label`/place names).
  - **Card-fan carousel** — **SLOT**: interim = a simple horizontal, snap-scroll strip of reel
    covers (works with placeholder thumbnails); swap in the user's card-fan carousel component
    when its prompt arrives. Keep the reel-tile render in a small subcomponent so the swap is a
    one-file change.
  - Opens as a full-height sheet/overlay over the map shell (match `CountryTrays`' sheet idiom).
- **Tests** — filter chip narrows the list by country; search narrows by text; clicking a reel
  fires `onOpenReel(card)`.

### T1.4 — Create-tray flow (name-only)
- **New** `frontend/components/reels/CreateTrayDialog.tsx` — `{ cards, onCreated }`.
  - Reel picker = card-fan picker **SLOT** (interim: the same reel-tile grid/strip with a
    selectable checkmark), country-filtered (reuse T1.3's filter).
  - A **name** field (required, trim, 1–80 to match the DB constraint; disable Create if empty
    or a case-insensitive duplicate of an existing collection name — mirror the unique index).
  - Create → `createCollection(name)` then `addReelsToCollection(id, pickedIds)` → `onCreated`.
  - Leave description/visibility/auto-add OUT (deferred; note in a code comment + this plan).
- **Tests** — picking reels + a name → asserts `createCollection` then `addReelsToCollection`
  called with the right ids; empty/duplicate name disables Create.

### T1.5 — Nav cleanup
- Confirm `components/dashboard/Sidebar.tsx` keeps `Home / Trails / Settings` (Trails →
  `/app/trips` → `TripsList`). No change needed beyond the home no longer duplicating trips.

**P1 browser QA (gstack `/qa`):** create a tray from picked reels; it appears as a folder;
open the Library banner; filter by country + search; open a reel (P2 wires the card). Evidence
required before P1 is "done".

---

## Phase 2 — Reel-info card + add-to-tray

### T2.1 — Reel-info card (lean)
- **New** `frontend/components/reels/ReelInfoCard.tsx` — `{ card, collections, onAddToTray }`.
  - Cover (`thumbnail_url` → placeholder). Reel caption/`personal_label` as the heading.
  - For each place in `card.places`: name, `country_name`, `evidence_quote`, "Source Reel" link
    (reuse the `CountryTrays` place-row idiom for consistency).
  - **Add to tray** — a menu of existing trays (+ "New tray…" → T1.4) → `addReelsToCollection`.
  - Match the `014/015_*.PNG` composition (cover on top, meta below), brass accent. Explicitly
    OMIT type badge / prose description / mentioned-in / reviews / map actions (deferred §4).
- Wire `LibraryPanel.onOpenReel` → open `ReelInfoCard`.
- **Tests** — renders each place row from a multi-place card; "Add to tray" calls
  `addReelsToCollection(collectionId, [card.id])`.

---

## Phase 3 — Create-trail from a tray

### T3.1 — Tray detail + Create trail
- **New** `frontend/components/reels/TrayDetail.tsx` — `{ collection, cards }` (cards filtered to
  the tray's members). Shows the tray's reels (folder or list) + a **Create trail** button.
- **Wire generation via the EXISTING seam** (no new pipeline): Create trail collects the tray's
  reels' places → routes into `SavedReelsFlow`'s existing **place-selection → brief → generate**
  path (`CountryTrays` for ≤5-place selection when the tray exceeds the cap → `PlanSheet` →
  `handleGenerate`). Reuse `toGenerateRequest` / `generateTrip` / `streamGeneration`.
  - **Respect `MAX_PLACES = 5`** — if the tray has >5 grounded places, the user picks ≤5 in the
    existing `CountryTrays` step; never bypass it.
- Add tray-management affordances: rename, delete, remove-reel (T1.1 already provides the calls).
- **Tests** — Create trail from a tray hands the tray's `place_ids` into the generate request;
  a >5-place tray routes through selection (does not auto-submit 6+).

**P3 browser QA (gstack `/qa`):** create tray → open → Create trail → place selection → brief →
generation → lands on `/app/trip/[id]` map. Evidence required.

---

## 7. Files touched (summary)

**New:** `lib/reels/collections.ts`, `components/reels/TraysScreen.tsx`,
`components/reels/LibraryPanel.tsx`, `components/reels/CreateTrayDialog.tsx`,
`components/reels/ReelInfoCard.tsx`, `components/reels/TrayDetail.tsx` (+ their `__tests__`).
**Reuse:** `components/ui/folder-gallery.tsx`.
**Modify:** `components/reels/SavedReelsFlow.tsx` (inbox phase → TraysScreen; wire create-trail).
**Delete/deprecate:** `components/dashboard/DashboardHome.tsx` (+ test).
**SLOT (await user's prompt):** card-fan carousel component, consumed by `LibraryPanel` +
`CreateTrayDialog` via a single reel-tile subcomponent.

## 8. Schema parity check (guardrail #4)

No Pydantic/DB change in v1 (uses existing tables + views). If we later add collection
description/visibility, that PR ships the migration + Pydantic + TS mirror together. TS types
(`ReelCollection`, `ReelCollectionItem`) already exist and mirror the DB.

## 9. Rollback risk

**Low.** Frontend-only; the `reel_collections` tables were empty/unused, so nothing depends on
them yet. Risk is UX regression on the home — mitigate by keeping `SavedReelsFlow`'s capture +
generate seams intact and shipping P1 behind the same route (no flag needed; revert = restore
`DashboardHome` render in `SavedReelsFlow`). Each phase is independently shippable.

## 10. Open items before handoff

- [ ] Card-fan carousel component prompt (user to supply) — until then, the interim reel-tile
      strip stands in; swap is one subcomponent.
- [x] ~~Confirm `reel_collections.user_id` insert path~~ — RESOLVED (this review): no default;
      MUST set `user_id` explicitly on every insert (see T1.1, migration lines 31–53).
- [x] ~~Codex peer review~~ — DONE (gpt-5.6-sol xhigh): NEEDS-REVISION 4.8/10; findings absorbed
      below (§11) + report at the end.
- [ ] gstack `/plan-design-review` — still pending (optional given UX was user-validated live).

## 11. Post-review revisions (2026-07-30, absorbing Codex `gpt-5.6-sol` xhigh)

Amendments to the tasks above. Each maps to a blocking finding (B1–B5).

- **[B1] Insert payloads.** Every insert sets `user_id` = `(await supabase.auth.getUser()).data.user!.id`
  (never from a caller/prop), for BOTH tables. Membership insert = `ignoreDuplicates` on the PK
  conflict only; all other errors surface. Concurrent create collisions on the unique name index
  → map Postgres `23505` to a clear "name already used" error (client-side disable is UX only).
  `createCollection` then membership-insert is **non-atomic**: on membership failure, keep the
  created (empty) tray, refresh state, surface the error, allow retry — do not orphan silently.
- **[B3] Create-trail handoff (rewrites T3.1's wiring).** `TrayDetail` (or TraysScreen) exposes
  `onCreateTrail(collection)`; the handler lives in `SavedReelsFlow` and reuses the existing state
  machine — NO new pipeline, NO reel-URL path:
  1. `const memberIds = new Set(membershipByCollection[collection.id])`
  2. `const trayCards = cards.filter(c => memberIds.has(c.id))`
  3. `const nextTrays = groupPlacesByCountry(trayCards.flatMap(c => c.places))` — dedups by
     `place_id` (organize.ts:18).
  4. If `!nextTrays.length` → BLOCK with a message ("organize this tray's reels first"); do not proceed.
  5. `setSelectedPlaceIds([]); setTrays(nextTrays); setPhase('trays')` → the existing
     `CountryTrays` (≤5 select) → `PlanSheet` → `handleGenerate`.
  6. **Preserve `handleGenerate`'s existing override** `reel_urls: [], requested_places: [], place_ids`
     (SavedReelsFlow.tsx:212) — the backend 422s on mixed reel-URLs + place-IDs (schemas.py:38).
     Use the **backend-aligned cap = 5** (local `MAX_PLACES`), NOT `MAX_TRIP_PLACES=8`.
  - **Tests (required):** 5 IDs generate · 6 IDs never reach `generateTrip` · duplicate places
    across reels count once · a `reel_urls`+`place_ids` mix is never emitted · a zero-grounded-place
    tray cannot proceed.
- **[B4] Tray card ≠ raw FolderGallery.** A `TrayCard` owns the chrome: name + reel count + a
  **distinct accessible "Open" control** (title-as-link or an explicit button) that opens
  `TrayDetail`. `FolderGallery` is the visual cover only (its click just fans photos) — do NOT
  wrap it in a button (nested interactive controls / a11y). **Empty tray:** `FolderGallery`
  returns `null` on empty, so `TrayCard` renders its own empty-folder cover + name + count(0) +
  Open control, so an empty tray stays openable / renamable / deletable.
- **[B5 / rollback] Risk upgraded Low → MEDIUM.** This replaces the authenticated home and its
  sole organize entry; repo inspection can't prove prod `reel_collections` rows are empty. Ship
  behind the phase DECISION below; keep `SavedReelsFlow`'s capture/generate seams intact for revert.
- **CreateTrayDialog** receives the existing collection names from TraysScreen state for the
  duplicate check; trim + length-validate (1–80) on **rename** as well as create.

### DECISION — DECIDED 2026-07-30: **Option B (incremental, preserve the old organize entry)**

Codex B2+B5: deleting the flat "Saved Reels" section removes the only `onOrganize` entry, so the
capture→organize→generate journey must not vanish mid-rollout.

**Chosen: B.** Ship P1 but keep a working select→organize action alive **until P3** lands
tray→trail, then remove it. Smaller, reversible PRs; one temporary extra path.

Implication for P1 (folded into T1.3): the Library panel gains a **multi-select mode →
`onOrganize`** (the same callback `DashboardHome` used), so the existing plan-from-selected-reels
journey survives P1/P2 intact. P3 removes it once "Create trail from a tray" is the primary path.
(Rejected: A — one big vertical slice; correct but a larger single PR than feasible-first wants.)

## GSTACK REVIEW REPORT

| Run | Reviewer / model | Status | Verdict |
|---|---|---|---|
| Code-seam verification | Claude (this session) | done | confirmed B1 (user_id), B2 (test mock), generate-seam + ≤5 cap |
| Peer review | Codex `gpt-5.6-sol` (xhigh) | done | NEEDS-REVISION |
| Design review | gstack `/plan-design-review` | not run | UX validated live with user instead |

**SCORES (Codex):** overall **4.8/10** — correctness 4 · completeness 3 · feasibility/scope 6 ·
maintainability 6 · risk-handling 4. Pass bar (overall ≥7.0, no dim ≤3): **FAILED** (completeness 3).

**Findings absorbed into the plan (§11):**
- B1 — insert payloads (user_id both tables; ignoreDuplicates-only; surface real errors; 23505; non-atomic). FIXED in T1.1 + §11.
- B2 — `TraysScreen` must carry `onCapture`/`onOrganize`; DashboardHome is the sole organize entry. FIXED in T1.2 (contract) + DECISION.
- B3 — Create-trail handoff undefined + 422 risk on mixed reel_urls/place_ids. FIXED in §11 (exact transition + tests).
- B4 — `FolderGallery` has no open-tray seam + null-on-empty. FIXED in §11 (TrayCard chrome + empty state).
- B5 — phases not independently shippable; rollback understated. Rollback → MEDIUM; phasing → DECISION.
- Non-blocking absorbed: doubled-greeting retracted (data artifact); MAX_TRIP_PLACES(8) not reused; 23505 mapped; partial-failure defined.

**VERDICT: NEEDS-REVISION → revised; phase-strategy DECIDED (Option B, incremental).** All five
blocking findings are addressed in the plan text above and the one open decision is resolved. The
plan is executable and ready for task-by-task implementation in a fresh session. Optional
`/plan-design-review` alongside the P1 Library/tray visuals.

NO UNRESOLVED DECISIONS
