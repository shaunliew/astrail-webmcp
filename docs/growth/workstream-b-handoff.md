# Workstream B — growth engine handoff

> Read-only query pack, ROADMAPS evidence, exact vault drafts, and founder decisions for the Astrail live-beta growth loop. No vault, production database, grant, analytics dependency, or deployment was changed.

## ROADMAPS tick verification

Primary evidence command:

```bash
git log origin/main --date=iso-strict --format='%h %ad %s' -- <relevant paths>
git merge-base --is-ancestor <feature-sha> origin/main
```

| ROADMAPS item | `origin/main` evidence | Production conclusion |
|---|---|---|
| Inspiration Library + Trays | `0b3752d` TraysScreen; `a96d26b` collections data layer; `f3e5124` TrayDetail; `b2a9043` create-trail; `b2a9043 ancestor-of origin/main: YES` | Keep tick. The release record says the frontend was manually published on 2026-08-07 after these commits. The authenticated screen cannot be independently exercised from a public unauthenticated endpoint, so present-day interactive behavior is not independently re-proven here. |
| Public-post (`/p/` carousel) ingestion | `a80ef07` URL choke point; `3007b94` actor routing; `eac35e0` capture/Telegram/cache pins; `17ec0d1` frontend labels; `a79318c` review fold; `a79318c ancestor-of origin/main: YES` | Keep tick. All implementation commits precede the recorded 2026-08-07 frontend/backend launch. A real ingestion requires authentication and would write production data, both outside this audit. |
| Trip-feedback UI | `ea33ce4` API seam; `7955f00` composer; `3923a63` workspace mount; `29a6fbd` duplicate-send fix; `3923a63 ancestor-of origin/main: YES` | Keep tick. Commits precede the recorded frontend publish. The UI is behind authenticated trip state, so current interactive behavior is not independently re-proven here. |

No ROADMAPS box should be unticked from the evidence available. The narrow uncertainty is current interactive deployment verification, not whether the work reached `origin/main` before the recorded launch.

## Exact new vault draft — `astrail/DISTRIBUTION.md`

```markdown
# DISTRIBUTION

> Astrail's operating plan for filling the live beta with the right users, measuring whether they activate, and turning their feedback into the next weekly distribution action. Zhi Hao owns the plan; Shaun owns the manual database grant step.

## Child of

* [[ASTRAIL]]

## The one weekly number

**Activated users:** `[CURRENT] / [FOUNDERS: TARGET]` as of `[DATE]`.

Activation means a user has generated at least one trip whose final status is `complete` or `saved_with_gaps`. The Monday source is `supabase/queries/growth/01_activation.sql`; do not count sign-ups, seat requests, draft trips, failed trips, or social impressions as activation.

Supporting diagnostics, not competing north stars:

* newly activated users this week
* repeat generators and repeat-pull percentage
* trip-feedback coverage, thumbs, and rating distribution
* granted beta seats, seats remaining, and pending requests

## Ownership

**Distribution owner: Zhi Hao.** He runs the weekly review, chooses the channel action, sends invitations, follows up, and updates this doc.

**Seat-grant operator: Shaun.** He performs the manual `users.plan` grant only after Zhi Hao identifies the recipient and the pre-grant count shows capacity. This is an operational handoff, not split ownership of distribution.

## Current seats

Source the live running count and holder list from `supabase/queries/growth/04_beta_seat_running_count.sql` each Monday and immediately before and after every grant.

**Running count:** `[GRANTED] / 25`<br>
**Seats remaining:** `[REMAINING]`<br>
**Pending requests:** `[PENDING]`<br>
**Last checked:** `[DATE, TIME, OPERATOR]`

`[FOUNDERS: Decide whether named seat holders and their acquisition source may be stored in this shared vault. Until decided, keep IDs/emails only in the privileged query result and put aggregate counts here.]`

The schema records the current holder (`users.plan='beta'`) and request time, but not grant time, grant source, or grant operator. Never use `users.updated_at` as a grant timestamp.

## Channel plan

| Channel | Who it reaches | Offer / action | Cadence | Owner | Weekly evidence |
|---|---|---|---|---|---|
| @haotobuildzip build-in-public X | People already following the build and AI/product makers who travel | Show one real product constraint, one shipped improvement, or one honest user lesson; invite people with saved travel Reels to request a beta seat. Use the `haotobuild` voice rules. | Tuesday build note; Friday proof/lesson or follow-up | Zhi Hao | post links, seat requests attributed manually, activations |
| Hackathon network | Sea × OpenAI participants, judges, builders, and warm contacts who saw the original demo | Send a direct note anchored in the shipped change from hackathon demo to live planner; ask for one real trip and one feedback response. | Wednesday invite batch; follow up once the next week | Zhi Hao | invites sent, seats requested, activations, feedback rows |
| Telegram ingest group | People already sharing travel Reels where Astrail's input behavior is natural | With group permission, post one concrete use prompt built around the group's shared Reels and a direct beta-seat path. Do not imply private group content is public. | One useful prompt per week, then answer replies | Zhi Hao | requests, successful first trips, repeat generators |
| Travel / Instagram communities | Travelers with saved Reels and a visible planning problem | Post a tailored workflow demonstration only where self-promotion is allowed; lead with Reel-to-route utility, not “AI travel” hype. | One community experiment per week; do not repeat a failed format without a changed hypothesis | Zhi Hao | community/link, requests, activations, qualitative objections |
| Activated-user referrals | Users who completed a real itinerary and can identify a similar traveler | Ask after successful generation or positive feedback for one relevant introduction; never gate product access on referral. | Friday follow-up to the week's activated users | Zhi Hao | asks made, introductions, referred activations |

## Weekly cadence

### Monday — measure and choose

1. Run the four read-only growth queries.
2. Update the one weekly activation number and supporting diagnostics above.
3. Review pending seat requests against remaining capacity.
4. Choose one channel hypothesis for the week: `[CHANNEL] → [AUDIENCE] → [MESSAGE] → activation`.

### Tuesday to Thursday — distribute and observe

Run the channel actions in the table. Record links and direct outreach counts without copying private messages into the vault. When someone requests a seat, record the source only in the founder-approved seat-list system.

### Friday — close the loop

1. Follow up with users who activated but did not leave feedback.
2. Read feedback comments and the rating/thumb distribution; do not collapse them into “positive” until [[GOALS]] defines that rule.
3. Note which channel produced activated users, not merely clicks or replies.
4. Continue, change, or stop the week's channel hypothesis and write one sentence explaining why.

## Manual beta-seat control

There is no code-enforced 25-seat cap.

1. Zhi Hao identifies the intended recipient and source.
2. Shaun runs `04_beta_seat_running_count.sql` and stops if `at_cap=true` or `over_cap=true`.
3. Shaun performs the existing manual one-user grant outside this document.
4. Shaun reruns the query and confirms the intended user is in the current-holder result and the count increased by exactly one.
5. Zhi Hao updates the aggregate count here and the founder-approved seat list.

If two grants could happen concurrently, pause one. A read-only count followed by a manual update is not an atomic code cap.

## Stop / change rules

* Stop a channel if it repeatedly produces attention but no activated users; rewrite the audience or offer before trying it again.
* Do not increase outreach volume while activation failures are caused by a product defect; fix or route around the defect first.
* Do not describe unverified product behavior or user outcomes as proof.
* Do not buy ads during the 25-seat manual beta unless the founders explicitly replace this plan.

## Open founder decisions

* `[FOUNDERS: Where does the named seat list live, and may that location contain user emails and acquisition source?]`
* `[FOUNDERS: What activation target and time horizon should the weekly number use?]`
* `[FOUNDERS: Is PostHog installed now for client-side funnel/retention events, or explicitly deferred while SQL remains the minimum viable measurement?]`
```

## Exact `astrail/GOALS.md` patch

Replace the existing `## Current goals` section body with the following. No founder-decided number is supplied.

```markdown
> **Targets require a joint Zhi Hao + Shaun decision.** Fill every bracket below together; do not treat the 25-seat operational cap as an activation goal unless the founders explicitly choose that.

1. **Activation** — a user generates at least one trip with final status `complete` or `saved_with_gaps`.
   * 🎯 Target: `[FOUNDERS: how many activated users?]`
   * ⏱ Horizon: `[FOUNDERS: by what date or within what rolling window?]`
   * 📏 Source: `supabase/queries/growth/01_activation.sql`
2. **Repeat pull** — an activated user generates a second distinct successful trip.
   * 🎯 Target: `[FOUNDERS: repeat-generator count, percentage of activated users, or both? What number?]`
   * ⏱ Horizon: `[FOUNDERS: by what date or cohort age?]`
   * 📏 Source: `supabase/queries/growth/02_repeat_generators.sql`
3. **Quality signal** — trip-level feedback on generated trips; PRD §18 makes this the primary beta-success measure.
   * 🎯 Target: `[FOUNDERS: feedback coverage and/or positive-signal target? What number?]`
   * ➕ Positive rule: `[FOUNDERS: thumbs-up only, or thumbs-up plus which rating values?]`
   * ⏱ Horizon: `[FOUNDERS: by what date or rolling window?]`
   * 📏 Source: `supabase/queries/growth/03_trip_feedback.sql`
4. **Build-in-public traction** — followers on @haotobuildzip.
   * 🎯 Target: `[FOUNDERS: follower target?]`
   * ⏱ Horizon: `[FOUNDERS: by what date?]`
   * 📏 Source: `[FOUNDERS: manual X profile check or approved analytics source?]`
5. **Cost discipline** — stay within the agreed infra and LLM budget without surprise spend.
   * 🎯 Ceiling: `[FOUNDERS: amount, currency, and monthly vs rolling-period basis?]`
   * 📏 Included costs: `[FOUNDERS: cash spend only, or credits consumed too?]`
   * ⏱ First review: `[FOUNDERS: date?]`

## Weekly operating note

Update actuals every Monday in [[DISTRIBUTION]]. Change a target here only when it is hit, disproven, or explicitly reset by both founders; do not silently move the goalposts.
```

## Founder decisions — do not infer

### Seat list

Choose one system of record for named holders and acquisition source:

1. **Database-only current roster** — query `users.plan='beta'`; lowest process overhead, but no grant timestamp/source/operator history.
2. **Shared-vault manual roster** — adds source and notes without schema work, but creates PII access and staleness risks that the founders must accept and assign.
3. **Durable database grant ledger** — best auditability and concurrency control, but requires backend/schema/migration work explicitly outside Workstream B.

Until decided, the query pack provides only current count, current holders, and pending requests. It does not pretend a historical ledger exists.

### PostHog now vs later

Choose explicitly:

1. **Now** — instrument client-side funnel and retention events that SQL cannot observe well (paste attempt, capture failure, organize start, trip view, feedback-panel exposure). This adds a dependency/integration, event taxonomy, privacy review, and deployment work.
2. **Later** — use the new SQL pack now for successful generation, repeat pull, feedback, and seats; document the missing pre-generation funnel and D1/D7/D30 behavioral events as an accepted blind spot with a dated trigger to revisit.

The locked stack already names PostHog as product analytics, but that does not decide timing. No PostHog dependency or event was added in this workstream.

## Worklog bullets for the main agent

- Added four read-only Supabase growth reports for activation, repeat generators, trip feedback, and the 25-seat running count/manual queue.
- Defined successful generation as trip status `complete` or `saved_with_gaps`; failed/in-progress rows do not activate users.
- Kept feedback signals disaggregated because founders have not decided which ratings count as positive.
- Verified the three ROADMAPS feature families are ancestors of `origin/main`; retained their ticks, with authenticated present-day interaction explicitly not independently re-proven.
- Drafted complete `astrail/DISTRIBUTION.md` content and a precise replacement for the GOALS current-goals body without editing the vault or inventing targets.
- Surfaced founder decisions for the named seat-list system and PostHog now-vs-later.
- GitHub Project #1 could not be loaded: the configured `gh` token for `BrownBOBAsushi` is invalid; no board state was guessed or updated.
