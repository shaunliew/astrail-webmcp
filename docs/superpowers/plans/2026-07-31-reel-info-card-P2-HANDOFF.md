# HANDOFF — P2 / T2.1 reel-info card + add-to-tray (branch `zh`)

> Written 2026-07-31 at end of session. Read this first when resuming. Full arc context lives in
> auto-memory `[[inspiration-trays-feature]]` and the SDD ledger `.superpowers/sdd/progress.md`.

## TL;DR — where it stands

**P2 / T2.1 is DONE — implemented, whole-branch reviewed (fable = SHIP-WITH-NITS + Codex cross-model),
all folds landed, and live-verified.** Session 2 (2026-07-31): covers now render end-to-end and every
review nit is fixed (see "Session 2 outcome"). **Only the PR/merge remains HELD** by Zhi Hao — do not
open a PR unprompted. Next task after the PR gate: **T3.1 — Create-trail from a tray** (Phase 3).

## Session 2 outcome (2026-07-31) — reviews run + folds landed

The reel-cover backend arc merged into `zh` (`2e7b06a`), but covers still rendered blank. Root cause +
fixes this session (all committed on `zh`, no merge/PR):
- **Covers were CSP-blocked.** `next.config.ts` `img-src` never allowlisted the Supabase Storage host
  (only the old Instagram CDN); the re-hosted `…supabase.co/storage/…` cover was refused. Fixed in
  `527ad57` (add the host + a regression test), later tightened to drop the tenant wildcard (`e390040`).
  Also: covers center-cropped (were top-cropped → sky), heading line-clamped.
- **Dev bucket + first cover live.** Applied migration `20260731120000` via the Storage API (bucket
  `reel-covers`), re-hosted one reel's cover (Gala Yuzawa) — verified rendering in the real app. The
  other ~10 reels stay placeholder until a backfill (`backfill_reel_covers.py --confirm`, ~10 Apify).
- **Whole-branch review RAN** (no longer held): `astrail-reviewer` (fable) = **SHIP-WITH-NITS**; gstack
  `/review` Codex cross-model. Findings folded: **C1 error-path** (a failed refresh after a successful
  add hid the tray list + "Added ✓") → ready-latch (`2828152`); **CSP over-broad** + **cross-instance
  add-lock race** (out-of-order refresh) → tighten + refresh-generation guard (`e390040`). The
  plan-mandated **add-flash (#52)** is subsumed by the ready-latch.
- **Deferred → GitHub #53** (a11y follow-up): no focus trap; `line-clamp` heading announced in full as
  the dialog name. Both data-safe, non-blocking.
- **Cleanup:** the `QA throwaway del` tray was deleted from the real account.

T2.1 frontend arc = `a0633f4 → 4ebc8a0 → 8fd702f → 527ad57 → 2828152 → e390040`. Gate: tsc clean,
vitest **286 passed / 6 known**. **Remaining: PR/merge (HELD) → then Phase 3 / T3.1.**

## What shipped (branch `zh`)

Plan: `docs/superpowers/plans/2026-07-31-reel-info-card-P2.md` (eng + Codex reviewed; blocking folds
B1/B2/C1/C2/C3). Implemented task-by-task via BUILD-LOOP subagent-driven-development:

| Task | Commit | What | Per-task review |
|---|---|---|---|
| T2.1a | `a0633f4` | `frontend/components/reels/ReelInfoCard.tsx` (+ test) — centered modal: cover + places + add-to-tray. C1 optimistic `locallyAdded`, C3 single-`addingId` disable-all lock, C2 doc-Escape + focus-restore, B2 fallible add | ✅ PASS — 5 guards fault-injected |
| T2.1b | `4ebc8a0` | `TraysScreen.tsx` (+ test) — `reelOverlay` in BOTH return branches, `traysWithReel` memo, C2 `inert` Library, B1 `setLibraryOpen(false)` on "New tray…" | ✅ PASS — 4 guards fault-injected |
| T2.1c | `8fd702f` | `CreateTrayDialog.tsx` `preselectedReelIds?` (lazy copied-array seed) + TraysScreen wire (+ both tests) | ✅ PASS — 2 guards fault-injected |

- **Gate:** `cd frontend && npx tsc --noEmit` clean · `npx vitest run` = **285 passed / 6 known
  failures** (TripMap ×1 + OnboardingWizard ×5 — pre-existing baseline; +18 new tests, zero new fails).
- **HEAD at handoff = `8fd702f`.** Re-verify with `git log --oneline -3` — a parallel workstream has
  been pushing to `zh` (see below), so HEAD may have advanced again.

## IMPORTANT — branch state changed under us

A **separate backend arc** `feat/reel-cover-thumbnails` (Python cover re-hosting + Supabase Storage
migration + backfill script; its own T7 whole-branch review trail; see `[[reel-cover-thumbnails-plan]]`)
was **merged into `zh` (`2e7b06a`)** by a parallel workstream mid-arc. So `zh` now carries BOTH arcs.
My T2.1 frontend arc is only `a0633f4 → 4ebc8a0 → 8fd702f`. **The whole-branch review + PR must decide
scope:** review just the T2.1 frontend diff, or the whole branch (the reel-cover arc was already
T7-reviewed separately). Ask Zhi Hao.

## Live /qa result (real auth, throwaway tray) — PASSED

Drove the full flow on the real account (Desmond Chye) via gstack `/browse` + imported Chrome cookies,
using an isolated tray **"QA throwaway del"** (never touched "Tokyo December trip"): create empty tray
(real Supabase write) → open Library → tap Gala Yuzawa reel → ReelInfoCard (null-thumb placeholder,
caption heading, "Places found · 1", place row + pin, View Reel) → `traysWithReel` correct ("Tokyo
December trip" already Added ✓) → Add: Add → Adding… (in-flight lock) → Added ✓ (optimistic) → grid
count 0→1 → reopen fresh card → throwaway "Added ✓" PERSISTED (from refreshed membership) → B1
"New tray…" closed Library + opened CreateTrayDialog preselected ("1 selected"). No console errors on
fresh load (a "Syntax Error" seen mid-run was a STALE browse-buffer entry from the parallel workstream's
hot-reloads — clear+reload was clean; committed code is tsc-clean).

## Open loose ends (decide with Zhi Hao)

1. **Leftover throwaway tray** `QA throwaway del` (1 reel) persists in the REAL account — there is no
   delete-tray UI until P3. Offer to remove it with a one-off `deleteCollection(id)` script (or leave it).
2. **UX papercut (per-spec, not a bug):** reels with null `personal_label` render the ENTIRE caption as
   the ReelInfoCard `<h2>` (wall of text, pushes add-to-tray below the fold). Matches `LibraryPanel`'s
   `reelLabel` idiom. Candidate: `line-clamp` the heading. Decide: fold into issue #52 or a new ticket.
3. **Deferred Minor → GitHub issue [#52](https://github.com/MalaysiaKaki/astrail/issues/52):** the
   plan-mandated "add flash" — `onAddToTray` awaits `refresh()`, which flips the shared `loading` flag,
   so the card's tray list flashes "Loading your trays…" on every add. Harmless (settles to Added ✓).
   Fix candidate: a distinct `'adding'` state, or a refresh that doesn't toggle page-level `loading`.

## What's next (when Zhi Hao says go)

Per `.claude/docs/BUILD-LOOP.md`, remaining steps for the T2.1 arc:
- **Step 5** — final whole-branch `astrail-reviewer` (`model: fable`, adversarial).
- **Step 6** — gstack `/review` (Codex `gpt-5.6-sol` cross-model on the code). **Run BOTH 5 & 6.** Put
  the deployment reality in the Codex prompt (what's on `dev`, that the reel-cover backend arc also
  merged into `zh`), and ask for consequences beyond the accepted scope.
- **Step 8** — PR to `dev` (or the target base) with the review + /qa trail; merge; sync; delete branch.
  **Only on Zhi Hao's explicit ask.**
- **Step 9** — record: update `.claude/docs/`, EMDEE (shared vault DECISIONS LOG + roadmap snapshot),
  memory `[[inspiration-trays-feature]]`; hand Codex the GitHub Project #1 board-card update.
- Then **P3** (create-trail-from-tray via the existing generate seam, ≤5-place cap) is the next arc.

## HARD CAVEATS (do not violate)

- **NEVER stage/commit** `frontend/components/map/TripMap.tsx` or `frontend/components/trip/TripWorkspace.tsx`
  — unrelated pre-existing WIP (still dirty). Also leave the other pre-existing dirty/untracked files
  (`docs/…/2026-07-30-inspiration-trays-HANDOFF.md`, `skills-lock.json`, the `higgsfield-*` skills,
  `docs/…/2026-07-31-reel-cover-thumbnails.md`, and THIS handoff file) alone unless asked.
- **NEVER `git add -A`** — the working tree is shared with other sessions. Stage explicit paths only.
- **Commit trailer required** (every commit on `zh` carries it; overrides any no-attribution default):
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- **Frontend style:** single quotes, no semicolons. `git diff --stat` before every commit (VS Code
  Prettier-on-save churns files). Gate = `cd frontend && npx tsc --noEmit` + `npx vitest run`; baseline
  **285 passed / 6 known**; a change is clean only if it adds zero new failures.
- **/qa is real-auth-only** (`app/app/(shell)/page.tsx` routes mock → CreateTripFlow). Keep
  `NEXT_PUBLIC_MOCK_AUTH=false`; import Chrome cookies:
  `~/.claude/skills/gstack/browse/dist/browse cookie-import-browser Chrome --domain localhost`
  (needs a macOS Keychain approval). Dev server was running on `:3000`. **No writes to the real account
  without Zhi Hao's OK** — use a throwaway tray.

## Key files
- Plan: `docs/superpowers/plans/2026-07-31-reel-info-card-P2.md`
- SDD ledger: `.superpowers/sdd/progress.md`
- Loop: `.claude/docs/BUILD-LOOP.md` · Routing: `.claude/CLAUDE.md`
- Memory: `[[inspiration-trays-feature]]`, `[[reel-cover-thumbnails-plan]]`, `[[working-style-consult-forks]]`
