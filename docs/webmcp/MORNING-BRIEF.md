# Morning brief — 2026-08-30

Written overnight. Deadline **Wed 3 Sept 13:00 PT = Thu 4 Sept 04:00 GMT+8**, so roughly four days.
Everything below is verified against the code or explicitly marked as unverified.

## Do these in order

Each is something only you can do. The first is new and is an **eligibility** item, not a nicety.

### 1. Change the default branch to `feat/webmcp` — one setting, three problems

**This is bigger than the license, and it is the single highest-value action available.**

`origin/main` is **148 commits behind and contains zero WebMCP code** — no `frontend/lib/webmcp/`,
no LICENSE, and a README that never mentions WebMCP. A judge clicking the repo link lands on the
**default branch**, so today they would see an entry with no WebMCP implementation at all. Devpost
explicitly requires the repo to visibly contain `document.modelContext.registerTool({...})`.

Changing the default branch to `feat/webmcp` fixes all three at once: the code becomes visible, the
README a judge reads becomes the right one, and the LICENSE badge appears (canonical MIT, detector
will recognise it).

⚠ **Do NOT merge `feat/webmcp` into `main` to achieve this.** `render.yaml` deploys from
`branch: main` with `autoDeployTrigger: checksPass` — merging would auto-deploy the hackathon
branch to **production**. An earlier draft of this brief suggested putting LICENSE on `main` as an
alternative; that was written before I checked what `main` deploys. Use the default-branch setting.

Verify afterwards that the About badge actually renders — the rule is about what a judge sees on
the repo page, not about the file existing.

### 2. The two merges

Simulated with `git merge-tree` and then **built**, so this is measured rather than predicted.
Full detail in `docs/webmcp/MERGE-PLAN.md`.

```bash
git merge wt/receipts     # zero conflicts
git merge wt/layout       # 4 hunks in 2 files — take wt/layout's side in ALL FOUR
cd frontend && npx tsc --noEmit && npx vitest run   # expect 114 files / 1263 tests
```

Taking layout's side is not a judgement call: in two hunks `feat/webmcp`'s side is *empty*, and in
the other two layout's text contains yours and extends it. Order matters only because receipts is
the smaller change; they touch disjoint files.

Re-verified after both branches gained commits: still four hunks, and the built result is
**113 files / 1256 tests, tsc clean, production build clean.**

⚠ **The rule is position-sensitive.** An implementer added a test mid-block on `wt/layout` and git
aligned it with `feat/webmcp`'s own new test into an add/add conflict at *six* hunks — where
applying "take layout's side" blindly would have silently **deleted** your clock test. It was
repositioned and both tests are confirmed present in the merged tree. **If you see six hunks
instead of four, stop and read `MERGE-PLAN.md` before resolving.**

### 3. Deployment settings

| Setting | Why |
|---|---|
| `WEBMCP_EDITS_ENABLED=true` | Gates all five edit tools. **Defaults off.** Unset, a judge approves an edit and is told the trip does not exist |
| `plan='beta'` on every judge account | `TRIAL_LIFETIME_LIMIT=1` — a trial account gets **one generation ever**, for the whole judging period |
| `DAILY_TRIP_QUOTA` raised | Default 5/day/user, shared across judges stress-testing |
| `RUN_DELETION_SWEEP` **unset** | Arms a sweep that permanently deletes user accounts every 120s. A second backend on the same Supabase project sweeps **real users** |

All four are now documented in `backend/.env.example`, which did not mention any of them until
last night. Note the parse asymmetry recorded there: a typo in `WEBMCP_EDITS_ENABLED` turns writes
**on**, while `RUN_DELETION_SWEEP` arms only on the exact string `true`.

### 4. Repo public, then the live URL

Both still outstanding. The README and SUBMISSION mark them as the two known blanks.

## What changed overnight

| Area | Outcome |
|---|---|
| Claim audit | Two claims a judge could disprove, one self-contradiction, one stale number — all fixed |
| Eligibility record | Was seven deliveries behind, including the evidence fix and the whole free path |
| `backend/.env.example` | Four undocumented flags added, two of them dangerous |
| Video script | Written, shot by shot, with exact prompts — then contract-tested, which found three of its claims false |
| A false instruction to judges | README and SUBMISSION told judges to type *"Show me day 2 in 3D"*, which returns an error |
| Landing-page overclaim | Two places promised approval for "anything that spends money"; `save_reels` spends and does not ask |
| Tracking docs | Status table was reporting four shipped items as unbuilt |

### The finding that would have cost the most

**README:113 and SUBMISSION:139 told a judge to type *"Show me day 2 in 3D."*** `set_map_mode`'s
enum is `route|hub` — there is no 3D mode, so that prompt returns an error. A judge following our
own written instruction watches it fail.

It could not have been fixed by adding a mode, either: the extruded-buildings layer is `minzoom:
15` and the deepest tool-driven camera is `zoom 14`, so **no tool can reach the buildings**. Only
the popup's street-level button can, by click. That demo beat had been in the plan since day one
and was never tool-reachable — nobody noticed because nobody ran it. If you want buildings in the
video, click a pin and narrate it as your move, not the agent's.

### The audit's most important finding

Our own two documents contradicted each other. README claimed all three edit tools "have been
exercised live through an agent against a real trip"; `T4-QUEUE.md` said `move_place` and
`remove_place` are "unit-tested only — no live writes". A judge reading both sees us contradict
ourselves in the paragraph where we make the most noise about being honest.

Only `add_place` is corroborated — **your** Codex run that added Osaka Castle, which is what
surfaced the stale-prose bug `replan_trip` now answers. README now says exactly that and no more.

## Needs your judgment, not your keyboard

- **The overlay collision was REAL, and is fixed.** Confirmed in a real browser and photographed:
  at 390px the prompts panel covered the "Plan a trip from your 9 saved reels" CTA *with no user
  interaction at all*, and at 1280px the Save button was genuinely unclickable — a hit-test probe
  returned the panel, not the button. Neither branch could have caught it alone, which is why both
  passed their own tests. Fixed on `wt/receipts` (`99c1384`); before/after screenshots are in
  `docs/webmcp/evidence/merge-dock-*.png`. I checked the pair myself.
  **Still look at `/app` after merging** — two residual states remain, both recorded in
  `MERGE-PLAN.md`: on a phone with the read-back *expanded* the panel still covers the CTA (a state
  the user opened and can close), and at 1280 the collapsed rail clips ~12px of the third tray
  card while scrolled to the very top. Closing both properly needs a bottom pad in
  `app/app/(shell)/layout.tsx`, which belongs to neither branch — deliberately left for after.
- **`get_app_state` was rewritten after its logged ChatGPT verification.** SUBMISSION now says so
  rather than claiming live-verification it no longer has. One re-run in ChatGPT's browser fixes it
  properly.
- **A "Coming soon" line** for the Telegram bot sits on the secondary paste form. It is honest and
  matches the landing page, so it was left — but it is a "not finished" signal on a judged screen.

## Still not done, and why

- **`plan_trip_from_reels` has never been run end to end through WebMCP.** It spends real Apify and
  OpenAI credit, so it was never right to run unattended. It is the demo video's spine, and the
  video script deliberately routes around it by building on `/app/trip/demo` instead.
- **The weather warning invents a reason.** `runner.py:357` catches a bare `Exception` and always
  says "No forecast available this far ahead", so a timeout or provider 500 gets a confidently
  wrong cause. Deliberately not fixed: the starter prompt is now 10 days out, inside Open-Meteo's
  ~16-day horizon, so a judge will not trigger it, and editing the generation runner days before
  submission is a poor trade.
- **The trial-exhausted dead end.** A trial user in the agent flow cannot reach the seat request at
  all — the button that opens that sheet is disabled with no organized places. Judges will be on
  `beta`, so it should not bite, but it is a real product gap.

## Two operational notes worth keeping

**Codex panes cannot carry unattended work here.** Their sandbox asks approval for every shell
command — including `curl` against a server it was handed, and including reading local files. I
will not answer an agent's approval dialog on your behalf, so the pane stalls. Both cross-vendor
passes this week ran only because I declined the dialog and ran the commands myself.

**`frontend/.next` is shared mutable state.** A dev server on :3000 overwrites it with a
*development* build, and `next start` on that throws `EvalError` and 500s every route. That
produced a result which flatly contradicted a correct earlier verification of the middleware. Build
in a separate directory before trusting any production check.
