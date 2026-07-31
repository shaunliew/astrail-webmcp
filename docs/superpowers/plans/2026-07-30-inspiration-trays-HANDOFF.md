# Handoff — Inspiration Trays + Library (P1 in flight)

> Written 2026-07-31 (end of session). Resume point for the next session.
> Plan (authoritative): `docs/superpowers/plans/2026-07-30-inspiration-trays-and-library.md`
> Memory: `[[inspiration-trays-feature]]`. Branch: **`zh`**. Lane: frontend-only.

## TL;DR

**P1 is FEATURE-COMPLETE — T0/T0.1 + T1.1–T1.5 all done, all reviewer-APPROVED, committed on `zh`**
(2026-07-31). T1.3 `8ac95cb`+`eb68e47` · T1.4 `4035615` · T1.5 `6d1ec0f`. Browser `/qa` of the flow
DONE against real auth (see "T1.5 + /qa outcome" below). **Next: the P1-complete gate** — final
whole-branch `astrail-reviewer` (`fable`) **AND** gstack `/review` (Codex) → PR/merge/sync. Phase
strategy is **B** (incremental — keep a working organize→generate path alive until P3).

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
| T1.3 · LibraryPanel | `8ac95cb` + `eb68e47` | Full-surface Library (banner → panel, not a map overlay): country chips + case-insensitive search over **Browse** (card-fan, tap → `onOpenReel` P1-stub) and **Select** (grid → `onOrganize`, cap 5, per-tile status labels). Contained fan edit (`id` + `onOpen` → `<button>`, null-thumb placeholder, focus ring; gsap byte-identical). TraysScreen `libraryOpen` block swapped to `<LibraryPanel/>` + selection state moved in. Reviewer **APPROVE** — the fix round's unmount-guard regression was empirically verified (new test run against the pre-fix commit in a throwaway worktree: fails unguarded, passes fixed). Fan `/qa` CSS tuning deferred to T1.5. |
| T1.4 · CreateTrayDialog | `4035615` | Accessible modal (autofocus name, Escape/backdrop/Cancel) → name (trim, 1–80, case-insensitive dup disable + hint) + country-chip-filtered **selectable reel-tile picker** (**no cap**, reels optional). Create = `createCollection` then `addReelsToCollection`; **non-atomic-safe**: on attach failure keeps the created tray, refreshes, surfaces error, **Retry re-attaches with the same id (create runs once)**; 23505 → "already used"; `activeRef` guard. Wired into TraysScreen `createOpen`. Reviewer **APPROVE** (partial-failure guard traced + test-proven load-bearing). 9 tests. |

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

### T1.3 — LibraryPanel  ✅ DONE (`8ac95cb` + `eb68e47`, 2026-07-31 — APPROVE)
> Built per the "T1.3 sketch-driven amendments" section below (they override the bullets here —
> full-surface panel not a map overlay; Browse fan / Select grid mode toggle; status labels on
> Select tiles; fan `/qa` tuning deferred to T1.5). Original spec bullets kept for the record:
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

### T1.4 — CreateTrayDialog  ✅ DONE (`4035615`, 2026-07-31 — APPROVE)
> Built with the **selectable reel-tile picker** (not the display-only fan; decided with user) —
> no selection cap (trays are unlimited; the ≤5 cap is trip-gen only). 4 review Minors folded into
> T1.5 below. Original spec bullets kept for the record:
- New `frontend/components/reels/CreateTrayDialog.tsx` — `{ cards, onCreated }`.
- Card-fan reel picker (country-filtered, selectable) + required **name** field (trim, 1–80,
  disable Create on empty or **case-insensitive duplicate** of an existing collection name).
- Create → `createCollection(name)` then `addReelsToCollection(id, pickedIds)` → `onCreated`
  (TraysScreen's `refresh()`). Non-atomic: on membership failure keep the created tray, surface
  the error, allow retry (§11 B1). Description/visibility/auto-add stay OUT (deferred).
- Wire into TraysScreen's `createOpen` seam.
- Tests: picking + name → `createCollection` then `addReelsToCollection` with right ids;
  empty/duplicate name disables Create.

### T1.5 — Nav cleanup + P1 wrap-up  ✅ DONE (`6d1ec0f`, 2026-07-31 — APPROVE)
> Nav: no change (Sidebar already Home/Trails/Settings, no dup). Minors (a,c,e,f,g,h) folded;
> (b) already covered. Browser `/qa` done — see "T1.5 + /qa outcome" in the amendments. Original
> bullets kept for the record:
- Confirm `components/dashboard/Sidebar.tsx` keeps Home/Trails/Settings (likely no change).
- **Fold in these non-blocking follow-ups from P1 reviews:**
  (a) test: `addReelsToCollection` throws before any client call when `getUser()` returns no user
  (mirror the `createCollection` auth test in `collections.test.ts`);
  (b) test: the `MAX_SELECTED=5` cap blocks a 6th pick;
  (c) decide/fix the `TraysScreen` `isEmpty` contradiction — 0 cards + existing trays + a transient
  `listCollections` failure shows "No trails yet" AND the error banner at once (carried over from
  DashboardHome; not a new regression).
- **Fold in the T1.4 review Minors (non-blocking):**
  (e) `CreateTrayDialog` — disable/mute the name input once `createdId` is set; after a partial
  failure the field stays editable and shows the dup hint next to a Retry that ignores edits (misleading);
  (f) narrow `isDuplicateNameError`'s regex to the exact "already exists" phrase — the broad
  `/duplicate|unique/` can mislabel unrelated errors as "name already used";
  (g) add execution-based unmount-guard tests for the other 3 `CreateTrayDialog` async-setState
  branches (only the outer-catch has one today);
  (h) add a `TraysScreen`↔`CreateTrayDialog` integration test (click `+` → dialog mounts with the
  wired `existingNames`/`onCreated`/`onClose` props).
- Full `tsc` + `vitest` green (modulo the 6 known). **P1 browser `/qa`:** create tray → folder
  appears → Library banner → filter+search → open reel.
- **(d) DEFERRED FROM T1.3 — card-fan `/qa` CSS tuning (user decision 2026-07-31).** First real-page
  render of the fan; T0.1's pixel dims are a first cut. Needs mock auth (`NEXT_PUBLIC_MOCK_AUTH=true`;
  a `.env.local.bak-mockauth` sibling exists) + seeded saved-reel data to reach an authed `/app`.
  Tune the fan size/position classes in `components/ui/card-fan-carousel.tsx` here, folded into
  the P1 browser `/qa` above (do NOT QA the Library twice).

## When P1 is complete (per BUILD-LOOP)
Final **whole-branch** pass: `astrail-reviewer` (model `fable`, adversarial) **AND** gstack
`/review` (Codex cross-model) — run BOTH. Then `/qa` smoke of the flow → PR/merge/sync → update
`.claude/docs/` + EMDEE vault + this memory. Then P2 (ReelInfoCard + add-to-tray) and P3
(create-trail-from-tray via the existing generate seam, ≤5-place cap) per the plan.

## Task list IDs (this session's tracker — will not carry to a new session)
T0 #1 ✅ · T1.1 #2 ✅ · T1.2 #3 ✅ · T1.3 #4 ✅ · T1.4 #5 ✅ · T1.5 #6 ✅ · T0.1 #7 ✅. **ALL P1 DONE.**
Next work is the P1-complete gate (final whole-branch review) + PR, then P2/P3.

## T1.3 sketch-driven amendments (2026-07-31 — DECIDED with user, override the plan text)

User supplied two whiteboard sketches (home + Library) mid-session. Decisions locked before
building T1.3; where these differ from the plan, THESE WIN:

1. **Placement = full-surface panel, NOT a map overlay.** Clicking the "Your inspiration starts
   here" banner swaps the Trays home content for `<LibraryPanel/>` filling the paper `<main>`;
   `onClose` returns home. The plan's "full-height sheet over the map shell (CountryTrays idiom)"
   does NOT apply — the /app home is a plain paper page with no map behind it (`(shell)/layout.tsx`
   paints opaque paper; `CountryTrays`' `fixed inset-0` is only for phases that escape to the map).
2. **The card-fan (`SocialCards`) IS the Library hero** (browse), per the sketch. It's display-only
   (`CardItem {imgUrl, alt?, linkUrl?}`, no id/callback/selection). **DECISION #2 = Option A:**
   a **contained edit** to `card-fan-carousel.tsx` — add `id` to `CardItem` + optional `onOpen(card)`
   → render card as `<button>` when `onOpen` given; add a null-`imgUrl` placeholder surface.
   **gsap effect UNTOUCHED** (keys off `.fan-card`). Rejected: routed `/app/reel/[id]` page — the
   fan uses a raw `<a href>` so it'd hard-reload anyway, breaks the in-panel sketch, loses
   filter/search state; shareable URL not a v1 goal.
3. **Select→plan survives (DECISION #1 = keep, option b).** User: "still need it to make our product
   seamless and frictionless." Browse-vs-select can't share one tap on a fan card, so LibraryPanel
   gets a **mode toggle**: Browse (fan, tap → `onOpenReel`) vs **Select** (grid lifted from
   TraysScreen's interim block, ≤5 → "Plan a trip" → `onOrganize`). Removed in P3 once tray→trail
   is primary.
4. **`onOpenReel` in P1 = no-op stub** (real ReelInfoCard is P2/T2.1); test only asserts it fires.
5. **T1.2 status-label carry-over lands on the SELECT-mode grid tiles** ("Places found · N" /
   "Not analyzed" from `places.length` + `analysis_status`) — the fan stays image-only.
6. **P2 flag:** the sketch's reel-info card shows Name/**Type**/**Description**, but `place_type`
   + prose description aren't in the data yet (plan §4 defers) and a reel holds *multiple* places →
   P2's card shows cover + each place's name/country + `evidence_quote`. Not a T1.3 concern.

Field facts for the build: `SavedReelPlaceProof` = `place_id, name, lat, lng, country_code,
country_name, evidence_quote (NOT evidence_caption_quote), source_url, source_reel_url, confidence`
(`lib/reels/backend-types.ts:51-62`). `SavedReelAnalysisStatus` =
`not_analyzed|queued|processing|organized|location_not_found|failed`. Thumbnails are null now →
placeholder surfaces everywhere.

### T1.3 outcome (2026-07-31)
Built as `8ac95cb`; fix delta `eb68e47`. `astrail-reviewer`: NEEDS-REVISION (dropped the
`activeRef` unmount guard in `organize()` on the port out of TraysScreen + fan-button focus ring +
coverage gaps) → fixed → **APPROVE**. The guard regression was verified by *execution*, not
inspection: the reviewer ran the new guard test against the pre-fix commit in a throwaway
`git worktree` and it failed (`messageReads` 1 vs 0), proving it's load-bearing. `tsc` clean;
`vitest` 249 passed / 6 known-baseline failed. **As-built shape:** LibraryPanel owns
Browse/Select mode state; the fan gained `id?` + `onOpen` (a `<button>` branch, focus ring, null-
thumb placeholder) with the gsap effect byte-identical; TraysScreen's `handleOpenReel` is a P1
no-op stub. **Deferred to T1.5:** the card-fan `/qa` CSS tuning (fan pixel dims untouched). **Note:**
both T1.3 commits carry a `Co-Authored-By: Claude Opus 4.8 (1M context)` trailer per this
environment's git policy; the repo's prior history lacks it — drop on a final squash/rebase if repo
consistency is preferred (flag for Zhi Hao).

### T1.4 outcome (2026-07-31)
Built as `4035615`. `astrail-reviewer`: **APPROVE**, no Critical/Important. The non-atomic
create-then-attach guard is the crux and was traced + test-proven load-bearing: `createdId` is stored
after `createCollection` resolves; `submit()` branches `if (!collectionId) { …createCollection… }`,
so create runs **exactly once** across a fail→retry while `addReelsToCollection` re-runs with the same
id; the empty tray is never `deleteCollection`'d; `onCreated()` fires on the failure path so the new
tray shows immediately. Reviewer also cross-checked the client dup logic against the DB's real
`lower(btrim(name))` unique index (migration `20260718120000`). 4 non-blocking Minors folded into T1.5
(e–h above). `tsc` clean; `vitest` 258 passed / 6 baseline. Co-Authored-By trailer applies here too
(3 commits now: `8ac95cb`, `eb68e47`, `4035615`).

### T1.5 + /qa outcome (2026-07-31)
Code `6d1ec0f`, `astrail-reviewer` **APPROVE** — nav no-change; Minors (a) addReels no-user test,
(c) `isEmpty` gated on `!error` (RED→GREEN), (e) name input disabled in retry state, (f)
`isDuplicateNameError` regex narrowed to `/already exists/` (kept 23505 code branch), (g) 3
execution-based unmount-guard tests, (h) TraysScreen↔CreateTrayDialog integration test; (b) already
covered. `tsc` clean; `vitest` **267 passed / 6 baseline**. One non-blocking Minor (retry-disable
test doesn't cover the in-flight busy sub-state — verified safe by code-read).

**Browser `/qa` (done, real auth):** `#3` fan-tuning was done solo via a throwaway `/fan-qa` fixture
(deleted after) — fan geometry is good across 375/768/1440; **no CSS change made** (T0.1 first-cut
holds). `#1` full-flow `/qa` was run by importing the user's real Chrome cookies (localhost login, **5
real Japan reels**): verified the full-surface Library panel, Browse fan render, **Select grid + status
labels** ("Places found · N" / "No places found" — the T1.2 carry-over, working), **search** narrowing
(tonkatsu→1, zzzzz→"No saved reels"), country chips, Back nav, and the **CreateTrayDialog** (modal
render, empty-name→Create disabled, valid-name→enabled, reel picker + chips). No feature console
errors. **No data written** — the create was validated up to submit only (dialog closed; account
stayed at 0 trays), because P1 has no delete-tray UI (P3/T3.1) and writing to the real account needs
the user's OK. Screenshots in the session scratchpad.

**Two real-page findings (from `/qa`, both flagged to user, neither a code defect):**
1. **Fan sits low** under the real header+filters — fits at ≥900px tall, borderline clips on shorter
   laptops. OPTIONAL tune (reduce the fan section min-height/padding — NOT the FAN_POSITIONS
   geometry); left to the user's design call, not done unilaterally.
2. **Null `thumbnail_url`** on all reels → the Browse fan shows blank placeholder cards (expected per
   plan §4; Select grid is the more useful view until the backend populates thumbnails). Backend data
   gap, not a frontend bug.

**Still open at P1 close:** (i) whether to do a live persisted create-tray to verify "folder appears"
(needs user OK to write to the real account + a cleanup plan); (ii) the optional fan-sits-low tune;
(iii) drop the `Co-Authored-By` trailer on final squash (now 4 commits: `8ac95cb`, `eb68e47`,
`4035615`, `6d1ec0f`). Then the P1-complete gate (fable whole-branch + Codex `/review`) → PR.

---

## ▶ RESUME POINT — visual polish in flight (2026-07-31 PM, session expired mid-work) — READ FIRST

P1 (T1.1–T1.5) is built, reviewer-APPROVED, committed on `zh` (see Done table). We are **mid visual
polish** on the two card visuals, driven by live user feedback via gstack `/browse` screenshots
against the user's REAL localhost session. **None of the polish is committed yet.**

**Uncommitted working-tree changes — intentional WIP. Do NOT revert, NEVER `git add -A`:**
- `frontend/components/ui/card-fan-carousel.tsx` — **fan resized to a smaller 9:16** (lg
  `w-[10rem] h-[17.5rem]` → mobile `w-[6rem] h-[10.5rem]`), stage min-heights reduced (lg
  `min-h-[21rem]`), `getHeightMultiplier` idealPx updated to match, x-overlap tightened
  (`FAN_POSITIONS` x = ±13.75/±10/±5; `getSlotConfig` `x: distance * 10`). **gsap logic untouched.**
  Rationale: 9:16 = Instagram Reel aspect → full covers, no crop (user explicitly chose full covers
  over a flatter cropped card). **Status: user liked the 9:16-smaller + tight-overlap look but never
  gave the explicit final "commit it" — confirm on resume.**
- `frontend/components/ui/folder-gallery.tsx` — was resized, BUT this file is **likely being DELETED**
  (see the open decision). Don't polish it further.
- `frontend/app/size-qa/` — **THROWAWAY prototype harness** (public route `/size-qa`, currently
  rendering the 3 tray-card options). **Delete before any commit.**
- `docs/superpowers/plans/2026-07-30-inspiration-trays-HANDOFF.md` — this handoff.
- `frontend/components/map/TripMap.tsx`, `frontend/components/trip/TripWorkspace.tsx` — pre-existing
  UNRELATED WIP; **never stage/commit**.

**THE OPEN DECISION (user is deciding over lunch):** the dark `FolderGallery` tray card reads as a
murky navy blob because reel `thumbnail_url` is null (no covers yet). Replace it with a cleaner
tray-card cover. 3 options prototyped in `/size-qa` (each shown placeholder=now / colored=later):
- **A — fanned stack**: 3 covers in a small static fan (echoes the Library fan motif).
- **B — cover row (+N)**: clean row of 3 covers + a "+N" chip. Clearest with placeholders, shows
  count. **← orchestrator's recommendation.**
- **C — hero + stack**: one big cover + peeking edges. Minimal, previews only 1 reel.
Re-show them: dev server is on :3000 → `~/.claude/skills/gstack/browse/dist/browse goto
http://localhost:3000/size-qa` then `... screenshot <path>` and Read it.

**RESUME STEPS (once the user names their A/B/C pick):**
1. Confirm the fan-size look is approved (already in the working tree).
2. Build the chosen cover into the REAL `frontend/components/reels/TrayCard.tsx` — replace the
   `<FolderGallery/>` cover with the chosen layout using the reel `photos` (`thumbnail_url`; null →
   a **light paper** placeholder tile, NOT the dark night placeholder). Keep TrayCard's chrome
   (name-as-Open-control + count + empty state) intact.
3. `grep -rn "folder-gallery\|FolderGallery"` → once nothing imports it, **delete
   `frontend/components/ui/folder-gallery.tsx`** (+ any test). **Delete `frontend/app/size-qa/`.**
4. Live-verify at mobile/tablet/desktop via gstack `/browse` against the user's real `/app`:
   import cookies `~/.claude/skills/gstack/browse/dist/browse cookie-import-browser Chrome --domain
   localhost` (user is logged into localhost:3000 with 5 real Japan reels + a tray "Tokyo December
   trip"). **MOCK_AUTH IS A TRAP** — `(shell)/page.tsx` routes mock→CreateTripFlow, so the feature is
   real-auth-only; keep `NEXT_PUBLIC_MOCK_AUTH=false`.
5. `cd frontend && npx tsc --noEmit` (clean) + `npx vitest run` (baseline **267 passed / 6 known** =
   TripMap ×1 + OnboardingWizard ×5; add none). Add/adjust TrayCard tests for the new cover.
6. Commit to `zh`, staging ONLY changed files by explicit path. Suggested msg: `refactor(reels):
   resize card-fan (9:16 smaller) + replace folder tray-card with <chosen> (T1.5 polish)`. Add the
   `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer (env policy).
7. Optional light `astrail-reviewer` gate (visual/CSS diff).

**HELD until the user explicitly says go (never do autonomously):** the P1-complete gate (final
whole-branch `astrail-reviewer` on `fable` + gstack `/review` Codex), and the **PR/merge** to `main`.
User said "still have stuff to implement and fix."

**After the polish, when the user is ready:** P2 (ReelInfoCard + add-to-tray — `onOpenReel` is a P1
stub) → P3 (tray detail + create-trail — `handleOpenTray` is a stub). See §Phase 2 / Phase 3.
