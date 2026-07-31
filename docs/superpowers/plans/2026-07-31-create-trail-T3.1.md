# Plan — Phase 3 / T3.1: Create-trail from a tray + tray management (frontend)

> Detailed implementation plan for **Phase 3 / T3.1** of the master plan
> `docs/superpowers/plans/2026-07-30-inspiration-trays-and-library.md` (§198–212, and the
> §11 **B3** create-trail handoff spec at :260–275). Branch `zh`. P1 + P2/T2.1 are built,
> whole-branch reviewed, and committed. This doc expands T3.1 into implementable steps grounded
> in the current code seams. **Reviewed 2026-07-31** (eng-lens `astrail-reviewer` + Codex
> cross-model) → NEEDS-REVISION → all blocking findings folded (see GSTACK REVIEW REPORT).

## 1. Goal

Tapping a tray's **Open** control opens a **TrayDetail** surface listing the tray's reels, with
tray-management (rename, delete, remove-reel) and a **Create trail** button that routes the tray's
grounded places into the **existing** generate seam (≤5-place selection → brief → generate → the
3D map at `/app/trip/[id]`). No new pipeline. This turns the P1 no-op `handleOpenTray` stub
(`TraysScreen.tsx:108`) into a real surface and delivers the delete-tray UI missing since P1.

## 2. Scope

**In** (master §198–207): `TrayDetail.tsx` (the tray's reels + Create trail), tray **rename** /
**delete** / **remove-reel** (reusing the T1.1 data layer), and Create-trail via the existing
`CountryTrays` (≤5) → `PlanSheet` (brief) → `handleGenerate` chain (plus a small additive `onBack`
seam on `CountryTrays`).

**Out** (deferred — data absent or a bigger surface): auto-add-via-AI, tray description/visibility
(need a migration — v1 tray is `name, sort_order` only), the yaay #2–6 sort menu / in-folder date
picker / grouping, any new generate pipeline, sharing/discovery.

## 3. Decisions locked (2026-07-31, grounded + review-folded)

1. **The generate state machine stays in `SavedReelsFlow`.** It already owns `phase`, `trays`,
   `selectedPlaceIds`, `brief`, and `handleGenerate` (`SavedReelsFlow.tsx:20,28,205–251`). TrayDetail
   must NOT fork that state. Create-trail is a new `onCreateTrail` handler *in SavedReelsFlow*,
   prop-drilled down (mirroring how `onCapture`/`onOrganize` already flow SavedReelsFlow → TraysScreen).
2. **Reuse the `CountryTrays` → `PlanSheet` → `handleGenerate` chain — with ONE additive seam.**
   `CountryTrays` is source-agnostic (`CountryTrays.tsx:15–27`). Reuse it, but it currently exposes only
   `onPlan` (:129) and **no Back/Cancel** — reusing it as-is would trap a create-trail user with no
   escape (Codex). So add a small additive **`onBack`** prop → returns to the trays grid (clears the
   generate phase). This is the only change to the existing chain.
3. **Two INDEPENDENT guards, do not conflate them.** (a) `CountryTrays` enforces the ≤5 **count**
   (`disabled={!on && atMax}` at `:87`, `maxSelected={MAX_PLACES}`). (b) `handleGenerate:212` enforces
   **place_ids-only** (`generateTrip({ ...request, reel_urls: [], requested_places: [], place_ids:
   selectedPlaceIds })`) — this is what prevents the mixed-input 422 (`backend/api/schemas.py:38–44`),
   NOT the picker. Both must survive any future edit. **Never bypass `CountryTrays`, even for a ≤5-place
   tray** — all trays enter the picker with **zero** selections (`setSelectedPlaceIds([])`; never
   auto-submit, master :268). (No pre-selection — the earlier "≤5 pre-selected" wording was wrong.)
4. **`TrayDetail` mounts via a single early-return in `TraysScreen`, keyed by `openTrayId`** (NOT the
   collection object). Store `const [openTrayId, setOpenTrayId] = useState<string | null>(null)` and
   derive `const openTray = collections.find(c => c.id === openTrayId)`, so a **rename re-renders the
   displayed name** (a stored object would go stale after `refresh()` — Codex). `handleOpenTray(c) →
   setOpenTrayId(c.id)`. Place `if (openTray) return <TrayDetail … />` **before** the `libraryOpen`
   early-return — no both-branches overlay trick (TrayDetail opens only from the ungated grid at
   `TraysScreen.tsx:242`, unlike ReelInfoCard). If `openTrayId` is set but the tray vanished (deleted
   elsewhere), `openTray` is undefined → fall through to the grid.
5. **Tray management lives in `TrayDetail`, under ONE mutation-wide lock, with local reconciliation.**
   `renameCollection` (`collections.ts:47–57`), `deleteCollection` (`:59–63`),
   `removeReelFromCollection` (`:84–91`) are RLS-scoped (no owner param). Findings folded (Codex):
   - **One in-flight lock** (a single `busyId`/`mutating` flag) disables rename + delete + remove +
     **Create trail** while ANY mutation is in flight — so Create-trail can't capture a pre-mutation
     snapshot mid-remove, and two writes can't race.
   - **Reconcile locally on success, refresh best-effort.** `TraysScreen.refresh()` swallows read
     failures (`:61–63`), so a bare "await write; await refresh()" can leave a removed reel or a
     deleted tray visible if the follow-up read fails. After each *successful* write, update the parent's
     `collections`/`membershipByCollection` locally (drop the removed member id; apply the new name from
     `renameCollection`'s return; remove the deleted collection), THEN `refresh()` as a best-effort
     re-sync (same optimistic contract as T2.1's add).
   - **Rejection UX** for all three: keep TrayDetail open, preserve the in-progress value (e.g. the
     rename text), release the lock, show an inline `role="alert"`. (T2.1 only specced this for add;
     here it covers rename/delete/remove too.)
   - **Rename validates client-side BEFORE the call.** `renameCollection` does NOT trim/length-check —
     the 1–80 bound is a DB CHECK (`reel_collections_name_trimmed_length_check`, migration :39) that
     surfaces as a raw Postgres error. Reuse `CreateTrayDialog`'s existing client pattern (`NAME_MAX=80`,
     trim + case-insensitive dup against `collections`, `CreateTrayDialog.tsx:37,81–85,190`); only the
     duplicate `23505` gets a friendly server-side message.
6. **`onCreateTrail` handler has its own zero-place guard (master B3 step-4 — defense in depth).**
   Beyond TrayDetail's disabled button, the handler itself must block an empty set:
   ```ts
   const nextTrays = groupPlacesByCountry(trayCards.flatMap((c) => c.places)) // dedup by place_id
   if (!nextTrays.length) { /* signal TrayDetail to show an inline "no places to plan" error */; return }
   setTrays(nextTrays); setSelectedPlaceIds([]); setPhase('trays')
   ```
   A stale/programmatic/test invocation must NOT enter an empty, non-dismissible `CountryTrays`.
7. **`MAX_PLACES = 5` (`SavedReelsFlow.tsx:28`), NOT `MAX_TRIP_PLACES = 8`** (`parse-inspiration.ts:7`,
   an unrelated cap — B3 warns against conflating them).

## 4. Grounded seams (verified `file:line`)

- **Generate seam:** `SavedReelsFlow.tsx` — `Phase` (:20), `MAX_PLACES=5` (:28), `handleGenerate`
  (:205–237) with the place_ids-only override (:212), `phase==='trays'` → `<CountryTrays …
  maxSelected={MAX_PLACES} onPlan={()=>setPhase('brief')}/>` (:240), `phase==='brief'` → `<PlanSheet …
  onGenerate={handleGenerate}/>` (:242–251), nav `router.push(\`/app/trip/${tripIdFromResult(...)}\`)` (:225).
- **Backend contract:** `backend/api/schemas.py:11–44` `GenerateTripRequest` (`reel_urls`/`place_ids`
  both `max_length=5`) + `@model_validator require_reel_or_place` (:38–44, mixed → 422); route
  `backend/main.py:236 @app.post("/generate-trip")`.
- **Place dedup:** `frontend/lib/reels/organize.ts:18–38` `groupPlacesByCountry(places)` — skip-dupes at
  **:22** (`if (seen.has(place.place_id)) continue`) — already used by the organize path (`SavedReelsFlow.tsx:136`).
- **≤5 selection UI:** `frontend/components/reels/CountryTrays.tsx` props (:15–27), `maxSelected` (:24),
  checkbox `disabled={!on && atMax}` (:87), plan FAB `onPlan` (:129); **no Back today** → add `onBack` (T3.1b).
- **Tray→cards join:** `TraysScreen.tsx` — `membershipByCollection` state (:37), `cardById` map (:92),
  the join idiom (`(membershipByCollection[c.id] ?? []).map(id => cardById.get(id)).filter(Boolean)`) at
  **:230–235**. (The earlier `:118–126` citation was `traysWithReel` for ReelInfoCard — not the join.)
- **Insertion point:** `TraysScreen.handleOpenTray` stub (:108–109); `TrayCard.onOpen` (`TrayCard.tsx:37–46,80`),
  fired from the grid at `:242` (`onOpen={handleOpenTray}`).
- **Tray-management data layer:** `frontend/lib/reels/collections.ts` — `renameCollection` (:47–57,
  `.update({name}).eq('id', id)` — **no validation**), `deleteCollection` (:59–63),
  `removeReelFromCollection` (:84–91). Cascade: `reel_collection_items` deletes with the tray (migration
  `20260718120000_saved_reels_foundation.sql:53–54`) → no orphan rows on tray delete.
- **Name-validation idiom to reuse:** `CreateTrayDialog.tsx:37,81–85,190` (`NAME_MAX=80`, trim, dup).
- **Types:** `SavedReelCard.places: SavedReelPlaceProof[]`; `SavedReelPlaceProof.place_id` = the id fed to `place_ids`.

## 5. Tasks

> Each task = one `astrail-developer` pass (TDD), each `astrail-reviewer`-gated. Frontend style: single
> quotes, no semicolons. Gate = `cd frontend && npx tsc --noEmit` + `npx vitest run`; baseline **286
> passed / 6 known** (TripMap ×1 + OnboardingWizard ×5) — clean = zero new fails. **Each task must pass
> its OWN gate standalone** (see the prop-threading note in T3.1a). NEVER stage/commit
> `components/map/TripMap.tsx` or `components/trip/TripWorkspace.tsx`.

### T3.1a — `TrayDetail.tsx` (new + test) + mount + management (compiles standalone)

**New** `frontend/components/reels/TrayDetail.tsx`. Props:
```ts
{
  collection: ReelCollection
  cards: SavedReelCard[]                                   // the tray's member cards (parent filters)
  existingNames: string[]                                  // for rename dup-check (other trays' names)
  onRemoveReel: (savedReelId: string) => Promise<void>     // rejects iff the write failed
  onRename: (name: string) => Promise<void>                // parent validated+trimmed name reaches here
  onDelete: () => Promise<void>                            // parent deletes + returns to grid
  onCreateTrail: () => void                                // inert no-op in T3.1a; real in T3.1b
  onBack: () => void
}
```
Body:
- **Header:** name + reel count + **Back**. Inline **Rename** (edit field seeded with the name; trim +
  1–80 + case-insensitive dup vs `existingNames`, reusing `CreateTrayDialog`'s pattern; on submit →
  `onRename(trimmed)`). **Delete tray** (confirm → `onDelete`).
- **ONE mutation lock:** a single `mutating` flag disables rename submit, delete, every reel's remove,
  AND Create trail while any write is in flight. Each write is `try/catch` (mounted-guard): reject → keep
  open, preserve the value, inline `role="alert"`, re-enable.
- **Reels list:** `cards.map` → a reel row (cover thumb + label) each with **Remove** →
  `onRemoveReel(card.id)`. Do NOT drop the row until the write resolves (pessimistic, unlike add). Empty
  tray → "No reels in this tray yet." (distinct from the no-places create-trail hint below).
- **Create trail** button (brass): `disabled` when `mutating` OR the tray has **0 grounded places**
  (`cards.every(c => c.places.length === 0)`). Copy distinguishes the two zero cases: **no reels** → "Add
  reels to plan a trip"; **reels but none organized/grounded** → "Organize these reels first to plan a
  trip." Else `onClick={onCreateTrail}`.
- Full-page surface (early-return), not a modal → no `inert`/focus-trap needed.

**Mount + prop-threading** (`TraysScreen.tsx`): add `openTrayId` state (Decision 4). Add the
`onCreateTrail` prop to TraysScreen's signature NOW (so T3.1a compiles); SavedReelsFlow passes a
**temporary no-op** `() => {}` in T3.1a (Create trail renders but is inert until T3.1b). Early-return:
```tsx
const openTray = collections.find((c) => c.id === openTrayId)
if (openTray) {
  const trayCards = (membershipByCollection[openTray.id] ?? []).map((id) => cardById.get(id)).filter(Boolean)
  return <TrayDetail
    collection={openTray}
    cards={trayCards}
    existingNames={collections.filter((c) => c.id !== openTray.id).map((c) => c.name)}
    onRemoveReel={async (rid) => { await removeReelFromCollection(openTray.id, rid); /* drop rid locally */ await refresh() }}
    onRename={async (name) => { const updated = await renameCollection(openTray.id, name); /* apply updated.name locally */ await refresh() }}
    onDelete={async () => { await deleteCollection(openTray.id); setOpenTrayId(null); /* drop locally */ await refresh() }}
    onCreateTrail={() => onCreateTrail(trayCards)}
    onBack={() => setOpenTrayId(null)}
  />
}
```
(The "drop/apply locally" comments are the reconciliation from Decision 5 — update `collections`/
`membershipByCollection` state on success so a swallowed `refresh()` can't resurrect stale rows.)

**Tests** `__tests__/TrayDetail.test.tsx`: a row per member card; Remove fires `onRemoveReel(id)`, a
rejecting remove shows the inline error + keeps the row; Rename fires `onRename(trimmed)` and **rejects
empty/whitespace/>80/duplicate names client-side (no call)**; a successful rename updates the shown name;
Delete (post-confirm) fires `onDelete`; **while a mutation is pending, ALL controls incl. Create trail are
disabled**; Create trail is disabled + shows the right hint when 0 reels vs reels-with-0-places, enabled
otherwise; Back fires `onBack`. Extend `TraysScreen.test.tsx`: Open a tray → TrayDetail shows its reels;
delete → back on the grid + `refresh` re-run; **rename → the grid + header show the new name** (stale-object regression).

### T3.1b — real `onCreateTrail` handler + `CountryTrays` Back seam + B3 tests

- **`SavedReelsFlow.tsx`** — replace the T3.1a no-op with the real handler (Decision 6):
  ```ts
  function onCreateTrail(trayCards: SavedReelCard[]) {
    const nextTrays = groupPlacesByCountry(trayCards.flatMap((c) => c.places))
    if (!nextTrays.length) { setCreateTrailError('This tray has no places to plan yet.'); return }
    setTrays(nextTrays); setSelectedPlaceIds([]); setPhase('trays')
  }
  ```
  (Surface `createTrailError` back to TrayDetail, or gate purely on the disabled button + keep this as the
  defense-in-depth `return` — either way the phase must NOT change on an empty set.) Pass real
  `onCreateTrail` to `<TraysScreen … />`.
- **`CountryTrays.tsx`** — add an additive `onBack?: () => void` prop + a Back/Cancel control that calls
  it; `SavedReelsFlow` passes `onBack={() => setPhase('inbox')}` (returns to the trays grid). No other
  change to the picker. (Guard: keep `disabled={!on && atMax}` + `maxSelected` intact.)
- **`TraysScreen.tsx`** — `onCreateTrail` is already a prop from T3.1a; no generate logic here.

**Tests** (extend `SavedReelsFlow.test.tsx` + a `CountryTrays` test):
- **zero-grounded-place tray → handler blocks:** `onCreateTrail([...cards with no places])` does NOT
  change phase and never calls `generateTrip` (handler-level, master :274).
- **dedup:** a multi-country, duplicate-`place_id` tray → the `'trays'` phase renders each place once.
- **exact-5 success:** select 5 → brief → `handleGenerate` calls `generateTrip` with exactly those 5
  `place_ids` and **empty `reel_urls` + `requested_places`** (assert the request shape).
- **>5 cap:** a >5-place tray via create-trail → the 6th checkbox is disabled; `generateTrip` never
  receives more than 5 `place_ids` (master :208–209, :274 — untested in the repo today).
- **CountryTrays `onBack`** returns to the grid (phase → inbox), fired by the new control.

## 6. Guardrails / schema parity

- **#4 schema parity:** no Pydantic/DB/migration change — reuses `reel_collections` /
  `reel_collection_items` + `GenerateTripRequest` (place_ids ≤5). Nothing to mirror.
- **#1 no hallucinated places:** TrayDetail only *displays* `card.places`; Create-trail forwards their
  `place_id`s — invents nothing.
- **#5/#6 auth/owner:** every read/write is RLS-scoped (`collections.ts`, `/generate-trip`). Note:
  PostgREST delete/remove **return success even for a zero-match / RLS-invisible row** — so the contract
  is "the write request succeeded", not "a row was definitely affected"; the local reconciliation +
  best-effort refresh (Decision 5) is what keeps the UI honest, and strict row-count confirmation is
  deferred unless a bug shows it's needed.
- **B3 (place_ids-only):** enforced by reusing `handleGenerate`'s override (:212) — never a tray-specific
  generate call. The picker enforces the count; the override enforces the shape (two independent guards).
- **Deps:** none new.

## 7. QA (gstack `/qa`, real auth)

Open a tray → TrayDetail lists its reels → remove a reel (count drops, grid re-syncs) → rename (header +
grid update) → **Create trail** → `CountryTrays` shows the tray's places (≤5 pick; **Back** returns to
the grid) → brief → generate → lands on `/app/trip/[id]` with the 3D map. Delete a tray → back on the
grid, gone. Try an unorganized/no-places tray → Create trail disabled with the right hint.
Mobile/tablet/desktop. Real-auth-only; **confirm before any real-account write** (rename/delete/remove
mutate real data) — throwaway tray or Zhi Hao's OK.

## 8. Rollback

**Low / frontend-only.** Revert = restore the `handleOpenTray` no-op + drop the TrayDetail mount +
`onCreateTrail` + the `CountryTrays.onBack` prop. All additive. Independently shippable.

## 9. Files touched

**New:** `components/reels/TrayDetail.tsx` (+ `__tests__/TrayDetail.test.tsx`).
**Modify:** `components/reels/TraysScreen.tsx` (+ test), `components/reels/SavedReelsFlow.tsx` (+ test),
`components/reels/CountryTrays.tsx` (+ test — additive `onBack`).
**Untouched:** `PlanSheet`, `handleGenerate`, `lib/trip/api.ts`, the data layer, the backend, the DB.
**Never stage/commit:** `components/map/TripMap.tsx`, `components/trip/TripWorkspace.tsx`.

## 10. Test baseline

**286 passed / 6 known** (TripMap ×1 + OnboardingWizard ×5). All new/changed tests must pass; a task is
clean only if it adds **zero** new failures.

## GSTACK REVIEW REPORT

| Run | Reviewer / model | Status | Verdict |
|---|---|---|---|
| Eng-lens (plan) | `astrail-reviewer` (this session) | done | NEEDS-REVISION — 3 blocking (B3 handler guard dropped; missing B3 tests; T3.1a/b prop-sequencing compile gap) + 2 non-blocking; **every cited seam verified real** |
| Cross-model (plan) | Codex, read-only | done | NEEDS-REVISION — 8 blocking (adds: mutation reconciliation, rename stale-object, rename/delete rejection UX, rename validation false, CountryTrays no-Back, mutation↔Create-trail race, weak B3 tests, zero-place guard) + 5 non-blocking |

**Blocking findings — all folded above:**
- **Zero-place guard in the handler** (both) — Decision 6 + T3.1b add the `if (!nextTrays.length) return`
  master B3 step-4 guard, not just the disabled button.
- **B3 tests** (both) — T3.1b adds handler-level zero-place block, exact-5 success + request-shape,
  >5-cap (6th blocked / never >5 `place_ids`), dedup. (Noted: `MAX_PLACES`/`maxSelected` is untested in
  the repo today — this new path gets the regression.)
- **T3.1a/b prop-sequencing** (eng-lens) — T3.1a now threads the `onCreateTrail` prop with a temporary
  no-op so it passes its own `tsc` gate; T3.1b swaps in the real handler.
- **Mutation reconciliation** (Codex) — Decision 5: update `collections`/`membership` locally on each
  successful write, refresh best-effort (swallow-prone `refresh()` alone could resurrect stale rows).
- **Rename stale name** (Codex) — Decision 4: key by `openTrayId`, derive the collection from state.
- **One mutation-wide lock + rejection UX** (Codex) — Decision 5 + T3.1a: single `mutating` flag over
  rename/delete/remove/Create-trail; per-mutation reject → keep open, preserve value, `role="alert"`.
- **Rename validation** (both) — Decision 5: validate trim/1–80/dup client-side (reuse CreateTrayDialog),
  `renameCollection` does not.
- **CountryTrays no-Back** (Codex) — Decision 2 + T3.1b: additive `onBack` seam so create-trail isn't a trap.

**Non-blocking folded:** struck the "≤5 pre-selected" self-contradiction (Decision 3 — all trays enter
with zero selections); clarified the two independent guards (Decision 3 / §6); fixed the seam citations
(`:92` cardById + `:230–235` join, not `:118–126`; `organize.ts:22` skip); softened the "resolve iff
write landed" contract for PostgREST delete/remove (§6); split the empty-tray vs reels-with-0-places copy (T3.1a).

**VERDICT: NEEDS-REVISION → revised.** All 8 unique blocking findings are addressed in the plan text; the
seams were verified real by the eng-lens, and the fixes are localized (no scope growth beyond one additive
`CountryTrays.onBack` prop). Implementation-ready for `astrail-developer` task-by-task (T3.1a → T3.1b),
each `astrail-reviewer`-gated. A third review round was not re-run (the folds are direct responses to
concrete findings); available on request.

NO UNRESOLVED DECISIONS
