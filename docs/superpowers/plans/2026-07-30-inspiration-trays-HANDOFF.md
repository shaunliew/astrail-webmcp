# Handoff — Inspiration Trays + Library (P1 in flight)

> Written 2026-07-31 (end of session). Resume point for the next session.
> Plan (authoritative): `docs/superpowers/plans/2026-07-30-inspiration-trays-and-library.md`
> Memory: `[[inspiration-trays-feature]]`. Branch: **`zh`**. Lane: frontend-only.

## TL;DR

P1 is **4 of 6 tasks done, all reviewer-gated and committed on `zh`**. Paused at a clean
phase boundary at the user's request (after T1.2). Next up: **T1.3 — LibraryPanel** (unblocked).
Phase strategy is **B** (incremental — keep a working organize→generate path alive until P3).

## How this work is being run (keep doing this)

Standard Feature Build Loop, task-by-task (see `.claude/docs/BUILD-LOOP.md`):
**`astrail-developer` implements ONE task → `astrail-reviewer` gates it (adversarial, verifies
against real code, fault-injects the guards) → proceed to the next.** The orchestrator (main
session) writes detailed, self-contained task prompts, keeps the task list, and decides
proceed/fix on each gate. Dispatch developers with `subagent_type: astrail-developer`,
reviewers with `astrail-reviewer`.

### Non-negotiable caveats for every task
1. **Stage only your task's files.** Two UNRELATED pre-existing WIP files are modified in the
   working tree and MUST stay uncommitted: `frontend/components/map/TripMap.tsx`,
   `frontend/components/trip/TripWorkspace.tsx`. Never `git add -A` / `git add .` — stage by
   explicit path. (Verified clean through T1.2.)
2. **6 known pre-existing test failures** — `frontend/components/map/__tests__/TripMap.test.tsx`
   (1) + `frontend/components/onboarding/__tests__/OnboardingWizard.test.tsx` (5), from
   Mapbox-WebGL-in-jsdom + the WIP TripMap. A task is clean if `npx vitest run` adds **no new**
   failures beyond these 6. Full baseline right now: **237 passed / 6 failed**.
3. **One committer at a time.** Reviewers are read-only, so a reviewer + a developer can run in
   parallel, but never two committing developers at once (git index race on `zh`).
4. Verify each task: `cd frontend && npx tsc --noEmit` (clean) + focused `npx vitest run <files>`.

## Stack decision made this session (already applied)

`gsap ^3.15.0` was installed **with the user's explicit approval** for the card-fan carousel —
it's the **2nd** animation lib against the "motion is the one animation lib" stance. Logged as a
deliberate deviation in `.claude/docs/STACK.md`. **`motion` remains the default; gsap is scoped
to `card-fan-carousel.tsx` only.** Do not reach for gsap for new work.

## Done (commits on `zh`, all APPROVE)

| Task | Commit | What |
|---|---|---|
| T0 · card-fan carousel (SLOT) | `5d1a6c0` | Verbatim gsap fan carousel → `frontend/components/ui/card-fan-carousel.tsx` (default export `SocialCards`, exported `CardItem`). |
| T0.1 · card-fan CSS fix | `cc70829` | The paste shipped no `.fan-card`/`.fan-layout` CSS → fan collapsed to 0px. Reconstructed inline (absolute + `left-1/2` + negative-margin centering so gsap's transform composes; responsive stage/card heights matching the JS breakpoints 480/640/768/1024). **Pixel values are a FIRST CUT — tune in T1.3's /qa.** |
| T1.1 · collections data layer | `a96d26b` | `frontend/lib/reels/collections.ts` — list/create/rename/delete + batch-safe `addReelsToCollection` (`.upsert(..., {onConflict:'collection_id,saved_reel_id', ignoreDuplicates:true})` = ON CONFLICT DO NOTHING, no UPDATE grant needed) + `getMembershipsByCollection()`. `user_id` set from `supabase.auth.getUser()` on every insert (RLS `with check`). 13 tests. |
| T1.2 · TraysScreen | `0b3752d` | `TraysScreen.tsx` + `TrayCard.tsx` replace the DashboardHome inbox body (greeting + quick-capture + Library banner + Your-trays grid + create tile + empty state). Owns collections state (`refresh()`). Carries `{ cards, onCapture, onOrganize }`. **DashboardHome + its test DELETED.** SavedReelsFlow inbox render swapped (2-line diff; organize/trays/brief/generate untouched); its test mock swapped. |

## Interim seams T1.2 left in `TraysScreen.tsx` (T1.3/T1.4 replace these)

- `libraryOpen` state → **interim placeholder** (a lean select→organize strip, cap
  `MAX_SELECTED=5`, "Plan a trip" button calling `onOrganize(selected)`). This keeps the
  capture→organize→generate journey alive per DECISION B. **T1.3 replaces the whole `libraryOpen`
  block with the real `<LibraryPanel/>`.** (Search for the comment `// interim — replaced by <LibraryPanel/> in T1.3`.)
- `createOpen` state → interim placeholder. **T1.4 drops in `<CreateTrayDialog/>`** and wires it
  to `refresh()`.
- `TrayCard` "Open" control is an accessible but **inert stub** (`handleOpenTray` no-op) — Phase 3
  (T3.1) wires `<TrayDetail/>`. Not a bug.

## Remaining P1 tasks

### T1.3 — LibraryPanel  ← START HERE (unblocked: needs T0.1 + T1.1 + T1.2, all done)
- New `frontend/components/reels/LibraryPanel.tsx` — props `{ cards, onClose, onOpenReel, onOrganize }`.
- Header "Your saved reels lives here" + **country filter chips** (derive from
  `cards[].places[].country_code`; `All` + one per present country) + **search** (client-side on
  caption / personal_label / place names).
- **Card-fan carousel** (the T0 component) of reel covers below. First time it's on a real page →
  **run gstack `/qa` and tune the card-fan CSS values** (T0.1's dims are a first cut).
- **Multi-select mode → `onOrganize`** (DECISION B, respect `MAX_PLACES = 5`). Replaces the interim
  strip in TraysScreen's `libraryOpen` block.
- Full-height sheet over the map shell (match `CountryTrays` sheet idiom).
- **CARRY-OVER (T1.2 reviewer):** include per-reel **status-label** display ("Places found · N" /
  "Not analyzed") in the reel-tile render — it was dropped from T1.2's interim strip; plan T1.2
  named status-label coverage. The real tile render lives here.
- Tests: filter narrows by country; search narrows by text; clicking a reel fires `onOpenReel(card)`.

### T1.4 — CreateTrayDialog (also unblocked now: needs T1.1 + T0.1; independent of T1.3)
- New `frontend/components/reels/CreateTrayDialog.tsx` — `{ cards, onCreated }`.
- Card-fan reel picker (country-filtered, selectable) + required **name** field (trim, 1–80,
  disable Create on empty or **case-insensitive duplicate** of an existing collection name).
- Create → `createCollection(name)` then `addReelsToCollection(id, pickedIds)` → `onCreated`
  (TraysScreen's `refresh()`). Non-atomic: on membership failure keep the created tray, surface
  the error, allow retry (§11 B1). Description/visibility/auto-add stay OUT (deferred).
- Wire into TraysScreen's `createOpen` seam.
- Tests: picking + name → `createCollection` then `addReelsToCollection` with right ids;
  empty/duplicate name disables Create.

### T1.5 — Nav cleanup + P1 wrap-up (blocked on T1.3 + T1.4)
- Confirm `components/dashboard/Sidebar.tsx` keeps Home/Trails/Settings (likely no change).
- **Fold in these non-blocking follow-ups from P1 reviews:**
  (a) test: `addReelsToCollection` throws before any client call when `getUser()` returns no user
  (mirror the `createCollection` auth test in `collections.test.ts`);
  (b) test: the `MAX_SELECTED=5` cap blocks a 6th pick;
  (c) decide/fix the `TraysScreen` `isEmpty` contradiction — 0 cards + existing trays + a transient
  `listCollections` failure shows "No trails yet" AND the error banner at once (carried over from
  DashboardHome; not a new regression).
- Full `tsc` + `vitest` green (modulo the 6 known). **P1 browser `/qa`:** create tray → folder
  appears → Library banner → filter+search → open reel.

## When P1 is complete (per BUILD-LOOP)
Final **whole-branch** pass: `astrail-reviewer` (model `fable`, adversarial) **AND** gstack
`/review` (Codex cross-model) — run BOTH. Then `/qa` smoke of the flow → PR/merge/sync → update
`.claude/docs/` + EMDEE vault + this memory. Then P2 (ReelInfoCard + add-to-tray) and P3
(create-trail-from-tray via the existing generate seam, ≤5-place cap) per the plan.

## Task list IDs (this session's tracker — will not carry to a new session)
T0 #1 ✅ · T1.1 #2 ✅ · T1.2 #3 ✅ · T1.3 #4 (next) · T1.4 #5 · T1.5 #6 · T0.1 #7 ✅.
A new session should re-create its own task list from the "Remaining P1 tasks" above.
