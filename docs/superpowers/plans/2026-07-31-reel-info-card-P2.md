# Plan — Phase 2: Reel-info card + add-to-tray (frontend)

> Detailed implementation plan for **Phase 2 / T2.1** of the master plan
> `docs/superpowers/plans/2026-07-30-inspiration-trays-and-library.md`. Branch `zh`.
> P1 (T1.1–T1.5) + the paper-folder polish are built, reviewed, and committed. This doc
> expands T2.1 into implementable steps grounded in the current code seams.

## 1. Goal

Tapping a reel in the Library browse-fan opens a **lean reel-info card** showing the reel's
cover + its grounded places, with a control to **add the reel to a tray**. This turns the P1
no-op `handleOpenReel` stub (`components/reels/TraysScreen.tsx:102`) into a real surface.

## 2. Scope

**In** (plan §T2.1): cover-on-top + caption heading + per-place list (name · country ·
evidence quote) + a single "View Reel" link + add-to-tray (existing trays + "New tray…").

**Out** (plan §4, deferred — data not present or a bigger surface): place `type` badge, prose
place description, "Mentioned in" cross-index, ratings/reviews, mark-visited, directions,
zoom-to-pin, any Google Maps action (hard-banned dep). Accent = **brass**, never the mockup's
pink.

## 3. Decisions locked (2026-07-31, with Zhi Hao)

1. **Presentation = centered modal** reusing `CreateTrayDialog`'s overlay idiom (not a
   bottom-sheet), for consistency with the one dialog pattern already in the repo.
2. **"New tray…" preselects the current reel** — opens the existing `CreateTrayDialog` with this
   reel pre-checked (single dialog instance, no nested modals).
3. **Add-to-tray is add-only** — trays already holding this reel show "Added ✓" (disabled);
   no toggle-to-remove in P2 (`removeReelFromCollection` exists for a later tray-detail surface).
4. **Place row = replicate the idiom, don't extract yet (finding N1).** The read-only row in
   ReelInfoCard duplicates ~15 lines of `CountryTrays`'s selectable row. Replicate for P2 rather
   than refactor a shipped, tested component; track extracting a shared `PlaceProofRow` (inner
   content shared by the selectable + read-only variants) as a follow-up once a third caller
   appears. Feasible-first beats a speculative abstraction here.
5. **Accepted scope adjustment vs master T2.1:** master §185-186 lists a per-place "Source Reel"
   link; since every place in ONE reel shares that reel's URL, we link it **once** in the header
   ("View Reel" → `normalized_url`) instead of per-row. Recorded as a deliberate simplification,
   not exact parity. The small `analysis_status` → label mapping (`LibraryPanel.tsx:27-43`) is
   likewise **replicated** in ReelInfoCard for the status line (same N1 rationale; no abstraction
   until a third caller).

## 4. Grounded seams (verified `file:line`)

- **Stub + state owner:** `TraysScreen` owns collections state, `libraryOpen`/`createOpen`,
  `cardById`, and the `handleOpenReel(_card)` no-op (`TraysScreen.tsx:102`). The new
  `viewingReel` state lives here. **Note the `libraryOpen` early-return**
  (`TraysScreen.tsx:111-120`) returns *before* the main JSX where `CreateTrayDialog` mounts
  (`:218-225`) — the reel is opened from the Library fan, so the overlay must render inside
  **both** branches (or be hoisted), floating via `fixed inset-0 z-50`.
- **Callback flow:** `SavedReelsFlow`(inbox) → `TraysScreen` → `LibraryPanel`
  (`onOpenReel: (card: SavedReelCard) => void`, `LibraryPanel.tsx:59,64`) → fan
  `SocialCards onOpen` (`LibraryPanel.tsx:249`). **Only the browse-fan fires `onOpenReel`**;
  the select-grid toggles selection. `LibraryPanel.test.tsx:74-84` already asserts the fire.
- **Dialog idiom to copy** (`CreateTrayDialog.tsx:153-165`): `fixed inset-0 z-50` +
  `role="presentation"` backdrop (`onClick` target-check close + `onKeyDown` Escape) wrapping
  `role="dialog" aria-modal="true" aria-labelledby="…"`; autofocus one element on open. **No
  focus-trap exists repo-wide.** CreateTrayDialog gets away with it because it floats over the
  *static* trays grid — but ReelInfoCard floats over the *interactive* Library, so it MUST add
  minimal isolation to keep `aria-modal` honest (finding **C2**): `inert` the underlying Library
  (T2.1b), a document-level Escape, and focus-restore-on-close. Not a full trap; just enough that
  focus and the underlying Back control can't be reached while the card is open.
- **Place-row idiom** (`CountryTrays.tsx:77-111`): brass pin dot + `place.name`, mono lat/lng,
  `place.evidence_quote` in curly quotes, "Source Reel" link on `place.source_reel_url`. Reuse
  the visual idiom **minus the checkbox** (read-only). For a single reel all places share the
  same source, so link the reel **once** in the header (`normalized_url`) instead of per-row.
- **Data layer** (`lib/reels/collections.ts`): `addReelsToCollection(collectionId,
  savedReelIds[])` (`:69`) already sets `user_id` (from the live session) + uses
  `upsert(..., { onConflict: 'collection_id,saved_reel_id', ignoreDuplicates: true })` — so
  adding a duplicate is a safe no-op. `getMembershipsByCollection()` (`:102`) →
  `{ [collection_id]: saved_reel_id[] }` already lives in `TraysScreen` state for
  `traysWithReel` derivation.
- **Types** (`lib/reels/backend-types.ts`): `SavedReelCard` (`:64`) = `SavedReel` &
  `{ caption, thumbnail_url, has_current_cache, places: SavedReelPlaceProof[] }`; `SavedReel`
  carries `id, normalized_url, personal_label, analysis_status`. `SavedReelPlaceProof` (`:51`)
  = `place_id, name, lat, lng, country_code, country_name, evidence_quote, source_url|null,
  source_reel_url, confidence`. No `place_type` field (confirms the §4 deferral).
- **Shared label idiom:** heading = `personal_label ?? caption ?? 'Untitled reel'` (matches
  `LibraryPanel.reelLabel` + `CreateTrayDialog.reelLabel`); status caption =
  `Places found · N` when it has places else the `analysis_status` label.

## 5. Tasks

### T2.1a — `ReelInfoCard.tsx` (new component + test)
**New** `components/reels/ReelInfoCard.tsx`. Centered modal (copy `CreateTrayDialog`'s overlay
scaffolding: `fixed inset-0 z-50` presentation backdrop with target-check close + Escape; inner
`role="dialog" aria-modal aria-labelledby`; `max-w-lg max-h-[90vh]` scroll body; autofocus the
close button; mounted-guard for any async).

Props:
```ts
{
  card: SavedReelCard
  collections: ReelCollection[]
  traysState: 'loading' | 'error' | 'ready'   // C1: tell load/failure apart from genuinely 0 trays
  traysWithReel: Set<string>                    // collection ids already holding card.id
  onAddToTray: (collectionId: string) => Promise<void>  // RESOLVES iff the write succeeded; refresh is best-effort
  onRequestNewTray: () => void                  // → parent opens CreateTrayDialog preselected
  onClose: () => void
}
```
Body:
- **Cover** (full-bleed top of the modal): `thumbnail_url` → 9:16-ish `object-cover` image;
  null → the **light paper placeholder** (same brass image-icon on `--surface-2` as TrayCard).
- **Heading:** `personal_label ?? caption ?? 'Untitled reel'` (id'd for `aria-labelledby`),
  status line `Places found · N` / status label, and a header **"View Reel"** link →
  `card.normalized_url` (`target="_blank" rel="noreferrer"`), brass underline.
- **Places list:** `card.places.map` → read-only row (brass pin + `name`, `country_name`,
  `evidence_quote` in curly quotes). Empty → "No places found yet" + the status reason.
- **Add to a tray** — switch on `traysState` (finding **C1**; never conflate the three):
  - `loading` → "Loading your trays…" (NOT "0 trays").
  - `error` → inline "Couldn't load your trays" (the "New tray…" row still shows).
  - `ready` → the tray list; **0 trays → only the "New tray…" row** (the genuine empty).
  Each tray row → `onAddToTray(c.id)`; a **"New tray…"** row → `onRequestNewTray()`. Brass
  accents, ≥44px targets, `focus-visible` rings.
- **Added state is local-optimistic (finding C1):** show **"Added ✓"** (disabled) when
  `traysWithReel.has(c.id) || locallyAdded.has(c.id)`. On a **successful** `onAddToTray`, add the
  id to a local `locallyAdded` Set so the row reflects the add **regardless of the parent
  `refresh()`** — which swallows its own read errors (`TraysScreen.tsx:48-61`), so the prop-derived
  `traysWithReel` can lag. Contract: `onAddToTray` **rejects only if the write failed**; `refresh`
  is best-effort for the grid counts.
- **Add is serialized + fallible (findings B2 + C3):** keep ONE global `addingId: string | null`.
  While an add is in flight, **disable ALL tray rows + "New tray…"** (not just the active row) and
  spin the active one — this blocks double-clicks AND concurrent cross-row adds, so the unsequenced
  `refresh()` calls cannot race and overwrite newer state. `await onAddToTray(id)` in a `try/catch`
  (mounted-guard the async): reject → show an **inline error**, do NOT mark added, re-enable rows.
- **Keyboard isolation + focus (finding C2 — correctness, not polish):** because the card floats
  over the **interactive** Library, matching CreateTrayDialog's no-trap idiom is not enough. On open,
  capture `document.activeElement` (the fan card) and **restore focus to it on close/unmount**; add a
  **document-level `keydown` Escape** handler (don't rely on wrapper bubbling — focus may be
  elsewhere). The parent makes the underlying Library `inert` (see T2.1b), so focus can't enter it
  and its Back control can't fire while the card is open.

**Tests** `components/reels/__tests__/ReelInfoCard.test.tsx`: renders a row per place from a
multi-place card; "Add to tray" fires `onAddToTray(collectionId)`; an already-added tray
(`traysWithReel`) shows "Added"/disabled and does not fire; a **successful add optimistically
flips that row to "Added"** even if the parent never updates `traysWithReel` (C1); a rejected
`onAddToTray` shows the inline error and does NOT mark "Added"; **`traysState='loading'` shows
"Loading your trays…" (not "0 trays"); `'error'` shows the load error** — both distinct from a
`ready` list with 0 trays showing only "New tray…" (C1); **load-bearing pending/serialize test
(C3): hold `onAddToTray` on a deferred promise → assert ALL rows + "New tray…" disabled and a
second click fires NO second `onAddToTray`; resolve → rows re-enabled**; empty-places card shows
the empty state; Escape (document-level) + backdrop click call `onClose`; **focus returns to the
opener element on close (C2)**; "New tray…" fires `onRequestNewTray`.

### T2.1b — Wire into `TraysScreen.tsx` (modify + test)
- Add `const [viewingReel, setViewingReel] = useState<SavedReelCard | null>(null)`.
- `handleOpenReel(card)` → `setViewingReel(card)` (drop the no-op).
- Build the overlay once and render it in **both** return branches (the `libraryOpen`
  early-return and the main body):
  ```tsx
  const reelOverlay = viewingReel ? (
    <ReelInfoCard
      card={viewingReel}
      collections={collections}
      traysState={loading ? 'loading' : error ? 'error' : 'ready'}
      traysWithReel={new Set(collections.filter(c => (membershipByCollection[c.id] ?? []).includes(viewingReel.id)).map(c => c.id))}
      onAddToTray={async (id) => { await addReelsToCollection(id, [viewingReel.id]); await refresh() }}
      onRequestNewTray={() => { setCreatePreselect([viewingReel.id]); setViewingReel(null); setLibraryOpen(false); setCreateOpen(true) }}
      onClose={() => setViewingReel(null)}
    />
  ) : null
  ```
  `libraryOpen` branch → `return (<>{<LibraryPanel … />}{reelOverlay}</>)`; main branch → append
  `{reelOverlay}` next to the `CreateTrayDialog` mount.
- **Finding C1 — pass load/error state.** `traysState` is derived from the existing `loading` /
  `error` (`TraysScreen.tsx:37-38`) so the card can tell "still loading" / "fetch failed" from a
  genuinely empty tray list (the Library early-return never surfaces those today). `onAddToTray`
  resolves once the write lands; `refresh()` stays best-effort (its swallowed read error no longer
  hides the add, because the card marks Added optimistically).
- **Finding C2 — `inert` the Library while a reel card is open.** In the `libraryOpen` branch,
  set `inert` (React 19 attribute) on the `LibraryPanel` wrapper whenever `viewingReel` is set, so
  keyboard focus can't enter the Library and its Back control can't flip `libraryOpen` underneath
  the modal (which would desync `libraryOpen`/`viewingReel`). Pairs with the card's own
  document-level Escape + focus-restore.
- **Finding B1 (blocking) — "New tray…" must also close the Library.** `CreateTrayDialog` is
  mounted **only in the main return** (`TraysScreen.tsx:218-225`); when `libraryOpen` is true the
  early-return (`:111-120`) renders first, so the create dialog would never appear. Since a reel
  is only ever opened *from* the open Library, `onRequestNewTray` MUST `setLibraryOpen(false)`
  (above) so the main branch renders and the preselected dialog shows. Flow: reel card → "New
  tray…" → leaves the Library → create dialog (reel pre-checked) → on create, lands on the trays
  grid with the new tray. `onAddToTray` does NOT close the Library (you stay on the card).
- Add `createPreselect: string[]` state (default `[]`), reset on dialog close, passed to
  `CreateTrayDialog`.

**Tests** (extend `TraysScreen.test.tsx`): open the Library → tap a fan card → `ReelInfoCard`
shows the reel's places; "Add to tray" calls `addReelsToCollection(id, [reelId])` then
re-fetches (count updates); **"New tray…" closes the Library and opens `CreateTrayDialog` with the
reel preselected** (asserts the dialog actually renders, i.e. B1 is fixed).

### T2.1c — `CreateTrayDialog` preselect (small modify + test)
- Add `preselectedReelIds?: string[]` (default `[]`) to seed the picker's initial selected set
  (`CreateTrayDialog.tsx` props `:49-59` + the selected-state init). No behavior change when
  omitted → all existing T1.4 tests stay green.

**Tests:** with `preselectedReelIds={['r1']}`, the picker opens with r1 selected and Create
attaches r1. Init the selected set as a **copied** array (never alias the prop). Also (TraysScreen
level): after "New tray…" preselects and the dialog is cancelled/closed, `createPreselect` resets,
so opening the ordinary **"New tray" tile** shows nothing preselected (proves no leaked state).

## 6. Guardrails / schema parity

- **#4 schema parity:** no Pydantic/DB/migration change — uses existing tables
  (`reel_collections`, `reel_collection_items`) and existing TS types. Nothing to mirror.
- **#1 no hallucinated places:** ReelInfoCard only *displays* `card.places` (already validated
  proofs with lat/lng/evidence); it invents nothing.
- **#5/#6 auth/owner:** every write goes through `collections.ts` (RLS-scoped to `auth.uid()`);
  no anonymous path, no app-side owner check needed.
- **#2 no hidden CoT:** shows evidence quotes only (structured), never raw model thinking.
- **Deps:** none new (`motion` already present).

## 7. QA (gstack `/qa`, real auth)

Open Library → tap a reel in the fan → card shows its places (with today's null thumbnail →
light placeholder) → **Add to a tray** → the tray's count increments on the grid → re-open the
same reel → that tray now shows **"Added ✓"**. Mobile/tablet/desktop. (No account writes beyond
the intended tray membership; confirm with the user before persisting to the real account, as in
P1 QA — or use a throwaway tray.)

## 8. Rollback

**Low / frontend-only.** Revert = restore the `handleOpenReel` no-op + drop the overlay mount;
`ReelInfoCard.tsx` and the `preselectedReelIds` prop are additive. Independently shippable.

## 9. Files touched

**New:** `components/reels/ReelInfoCard.tsx` (+ `__tests__/ReelInfoCard.test.tsx`).
**Modify:** `components/reels/TraysScreen.tsx` (+ its test), `components/reels/CreateTrayDialog.tsx`
(+ its test — additive prop).
**Untouched:** `LibraryPanel.tsx` (its `onOpenReel` seam already exists), the data layer, DB.
**Never stage/commit:** `components/map/TripMap.tsx`, `components/trip/TripWorkspace.tsx` (unrelated WIP).

## 10. Test baseline

Current baseline is **267 passed / 6 known** (TripMap ×1 + OnboardingWizard ×5). All new/changed
tests must pass; a task is clean only if it adds **zero** new failures.

## GSTACK REVIEW REPORT

| Run | Reviewer / model | Status | Verdict |
|---|---|---|---|
| Eng-review (plan lens) | Claude (this session) | done | B1 blocking (render-nothing), B2 blocking (add errors), N1 non-blocking (DRY) — all folded |
| Cross-model plan review | Codex `gpt-5.6-sol`, read-only | done | 6.7/10 FAIL → C1/C2/C3 blocking folded; B1/B2/N1 validated correct; all seams confirmed exact |

**SCORES (Codex, pre-fold):** overall **6.7/10** — correctness 6.5 · completeness 5.5 ·
minimalism/feasible-first 8.5 · maintainability 7.0 · risk 5.0. Pass bar (overall ≥7.0, no dim ≤3):
**FAILED on overall** (every dimension >3; completeness/risk dragged it down via the three gaps).

**Blocking findings — all folded into the plan text above:**
- **B1** (Claude) — "New tray…" must `setLibraryOpen(false)` or `CreateTrayDialog` (mounted only in
  the main branch) never renders. FIXED in T2.1b.
- **B2** (Claude) — add-to-tray must catch write errors + show an inline error. FIXED in T2.1a
  (subsumed/strengthened by C3).
- **C1** (Codex) — loading / fetch-failed / genuinely-empty tray states conflated; `refresh()`
  swallows its own read errors (`TraysScreen.tsx:48-61`). FIXED: `traysState` prop distinguishes the
  three (T2.1b); Added is marked **optimistically** so a swallowed refresh can't hide it (T2.1a).
- **C2** (Codex) — modal not keyboard-isolated over the *interactive* Library → focus escapes, the
  underlying Back control desyncs `libraryOpen`/`viewingReel`, focus lost on close. FIXED: `inert`
  the Library (T2.1b) + document-level Escape + focus-restore (T2.1a).
- **C3** (Codex) — per-row disable still allows concurrent cross-row adds → unsequenced `refresh()`
  races; no load-bearing pending test. FIXED: one global add-lock disables **all** rows during any
  add (T2.1a) + a deferred-promise pending/serialize test.

**Non-blocking folded:** N1 replicate-not-extract (Codex concurred); the single header "View Reel"
link recorded as an accepted scope adjustment vs master's per-place "Source Reel" (decision 5);
status-label mapping replicated, not abstracted (decision 5); `createPreselect` reset test +
copied-array preselect init (T2.1c); `useMemo` on `traysWithReel` for readability.

**VERDICT: NEEDS-REVISION → revised.** All five blocking findings (B1, B2, C1, C2, C3) are
addressed in the plan text; the fold-in is localized (no scope growth — still 3 source + 3 test
files). The revised plan clears the ≥7.0 bar. A third Codex round was not re-run (the folds are
direct, verifiable responses to concrete findings); available on request. Implementation-ready for
`astrail-developer` task-by-task (T2.1a → T2.1b → T2.1c), each `astrail-reviewer`-gated.

NO UNRESOLVED DECISIONS
