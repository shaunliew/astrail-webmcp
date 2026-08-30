### Task 8 · landing page brought up to the current product · Shaun's request, dispatched

Shaun asked for the landing page to reflect the latest state, overnight. Sent to `claims-fix`
rather than a new agent — it already owns those exact files, and a second writer in
`landing-copy.ts` tonight would be the fourth same-worktree collision.

**The gap, found before dispatching rather than assumed.** `howItWorksSteps` is still the
pre-WebMCP story — "Paste the Reels you saved" → "Astrail verifies the places" → "Get a route
you can follow". That describes an app you OPERATE, in a challenge about apps you COLLABORATE
with. A judge landing on `/` currently sees no indication the agent exists at all. The most
distinctive thing in the build is invisible on the first page.

Ordered AFTER the 11 corrections, because those lose points and this gains them.

**Guards written into the brief**, since "add the new stuff" is exactly how tonight's false
claims were born:
- `move_place`'s card is IN FLIGHT (task 6, `auto-replan`). Told it not to write a sentence that
  depends on unlanded work — a claim against work in progress is a new instance of the defect
  being fixed. Either true-either-way, or leave it and report.
- No undo control exists. Hotels are off. No deployed URL exists. Nothing may imply otherwise.
- Nothing on the ROOT page may imply tools are registered there — that IS finding 7.
  `GlobalTools` mounts only under `/app`.
- `robots: noindex` and the what's-new block: report state, do not change metadata without
  asking. That is deployment behaviour and Shaun owns it.

### Task 7 · eleven false claims corrected · `b17a890` · PASS

Spot-verified the three highest-cost ones against the code rather than the report:

- **The evidence claim** is now both true and better. Was "attaches the source evidence to every
  stop"; now names all three provenances and closes with *"Three provenances, one label on every
  pin — nothing is on the map unattributed."* The overstatement had been costing us the actual
  differentiator: a stop that says "you asked for this, no Reel behind it" is the honesty no
  other entry will have, and the false universal buried it.
- **The hotel claim** is gone from `landing-copy.ts` — the app had been more honest than its own
  marketing, since `TripWorkspace` already told users newly generated trips have none.
- **"Sixteen tools answer" is gone from `StoryStage`**, which is the one a judge could have
  disproved in ten seconds: `GlobalTools` mounts only under `/app`, so the root page registers
  none.

Full suite green after it: **122 files / 1656 passed, 0 failed.** The `readme-webmcp-contract`
test that had been red for two rounds is passing — the deployment caveat survived the rewrite,
which was the requirement.

### Task 5 (final) · Codex round 7 dispatched · code half only

The code half of the night is frozen (`b2a9c9d`, `8e39f46`), so it goes to review now rather
than waiting on the doc work. Asked specifically for what my own injections could NOT see:
whether a DECLINED move leaves state behind in the edit counter (a declined move that raised
`edits` would make a later rewrite look permanently stale), whether 'You' is the right rail
actor on the decline and failure paths too, whether `refusal` can leak into the success path or
go stale across calls, and whether any entry can be opened without being closed.

Told it explicitly not to re-report the known token hazard, and to say plainly if the batch is
clean rather than manufacture findings at this hour.

