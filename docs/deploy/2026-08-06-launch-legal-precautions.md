# Launch legal precautions — handoff for discussion

> **Written 2026-08-06, two days before the Sat 2026-08-08 launch.** Output of a 4-agent
> adversarial sweep (legal-page truthfulness · IP/copyright · consumer claims & consent ·
> data-protection practice) over the `zh` worktree at HEAD `a01e6cc`. This is an
> engineering-level risk audit, not legal advice. Nothing here is fixed yet — this doc
> exists so Zhi Hao can decide, then a session executes.
>
> TL;DR: the security/data core is solid (see "Verified clean"). The exposure is three
> critical items needing a decision, four cheap copy/routing fixes, and one structural
> follow-up on the cover-image mirror.

---

## A. Decisions needed (the three criticals)

### A1. Privacy page promises deletion nothing can perform

- **Finding:** `frontend/app/privacy/page.tsx:131-146` promises account deletion and mem0
  memory erasure "on request". Both self-serve endpoints are hard-gated to 503
  (`_DELETION_EXECUTION_READY = False` at `backend/main.py:358`,
  `_CLEAR_RECONCILIATION_READY = False` at `backend/main.py:342`). There is **no manual
  path to initiate a deletion from an inbound email** — the founder-SQL remedy in
  `deletion_engine.py` only unsticks already-started deletions; the smoke script warns
  against use on real accounts (mem0 queue observed pending >17 min).
- **Exposure:** a PDPA deletion request arrives Sunday and cannot be fulfilled as promised.
- **Options:**
  1. **Flip the go-live switches** (`_DELETION_EXECUTION_READY` +
     `NEXT_PUBLIC_DELETION_ENABLED` + `RESEND_API_KEY`). The arc is code-complete and
     passed its pre-flip final review 2026-08-04 (fable SHIP + Codex, backend 1565 pass).
     Held for ZH's call — see the launch-gate-erasure arc notes + root `HANDOFF.md` §T6
     checklist for the flip procedure (live pgTAP 019/020 + `/qa` + honest `/privacy`).
  2. **Soften the privacy copy** to current capability ("email us; we process manually,
     allow up to N days") **and** write a manual SOP that uses the mem0 dashboard directly
     (bypassing repo tooling) so the promise is honest.
- **Recommendation:** Option 1 if there's bandwidth for the flip checklist before Saturday;
  otherwise Option 2 is a 30-minute honest fallback.

### A2. Real creators' content in our marketing assets

- **Finding:** `frontend/public/landing/screens/reel-library.webp` (wired at
  `frontend/components/story/story-config.ts:35`, rendered in HowItWorks) contains **7 real
  Instagram reel covers with the creators' own on-frame text** ("Amazing Chicken Nanban in
  Tokyo, Japan", "Top 3 Eats · Tokyo, Japan", …), no attribution, published as Astrail's
  own promotional screenshot. Reviewer opened the image; this is verified, not inferred.
- **Also:** `frontend/public/landing/astrail-beta-demo.mp4` (DemoVideoSlot) is a screen
  recording of the same app session and almost certainly shows the same covers in motion.
  **No agent can watch video — ZH must scrub it before launch.**
- **Exposure:** the most DMCA-shaped item in the repo: commercial reproduction of
  identifiable creators' work on the public landing page. Terms' "Your content" clause
  covers user-submitted links, not our own marketing use.
- **Options:** re-shoot the Library screenshot with mock/own covers · blur covers in the
  existing asset · crop the Library view out of the demo video (or re-record those
  seconds).
- **Decision needed:** which, and who does the media edit.

### A3. `/classic` stale landing + repurposed email list

- **Finding:** `/classic` is still built and served (no redirect in `next.config.ts`) and
  listed in `frontend/app/sitemap.ts:5-13` at priority 0.5 — contradicting its own
  `robots: { index: false }`. Its copy promises "we'll send an invite when the beta is
  ready" (`WaitlistSection.tsx:16-18`) — an invite flow that has never existed (beta is
  open; `signInWithOtp({ shouldCreateUser: true })`, no gate in middleware). Its Tally form
  is the **same list** (`QKjrvk`) the live landing now uses for "notify me about hotel
  booking" — emails collected under one purpose, used for another (PDPA/GDPR
  purpose-limitation).
- **Fix (cheap, low-risk):** redirect `/classic` → `/` and remove the sitemap entry.
  Separately: when the hotel-launch email eventually goes to the old list, first re-consent
  or segment out addresses collected under the waitlist framing.
- **Decision needed:** OK to kill the route? (It was kept as the pre-pivot landing
  reference; the code stays in git history regardless.)

## B. Cheap pre-launch fixes (no real decision, just approve the batch)

| # | Fix | Where |
|---|---|---|
| B1 | Add "By continuing, you agree to our [Terms] and [Privacy Policy]" under the Google button AND the email-OTP form (currently zero assent touchpoint — pure browsewrap) | `frontend/app/sign-in/page.tsx` |
| B2 | Add **Travala** to the "Who processes your data" list — it receives trip-derived location data on every generation (backend hotel enricher runs regardless of the frontend hub toggle; `backend/genagents/hotel.py`, `backend/pipeline/runner.py` enrich gather) | `frontend/app/privacy/page.tsx:96-118` |
| B3 | Soften seat copy: landing promises "most active early users" (`FinalCTA.tsx:41-43`, `StoryStage.tsx:63-64`) but granting is 100% manual SQL, no activity ranking exists in code. Terms already honestly says "at our discretion" — align landing to Terms | `frontend/components/story/sections/FinalCTA.tsx`, `stage/StoryStage.tsx` |
| B4 | Add an age/eligibility clause to Terms ("you must be at least 16 and able to form a binding contract" — matches privacy's under-16 line, which is currently the only age language and lives on the wrong document) | `frontend/app/terms/page.tsx` |
| B5 | Add a copyright/takedown contact line (e.g., to Terms or footer: "Copyright concerns: zhihao@astrail.xyz") so creators have a scoped channel — today the only removal tool is the full bucket nuke | `frontend/app/terms/page.tsx` or `StoryFooter.tsx` |

All five are copy/one-liner changes; one commit on `zh`, reviewable in minutes.

## C. Structural follow-up (soon after launch, not Saturday)

**The cover re-host pipeline is a public unresized mirror, not thumbnails.**
`backend/pipeline/thumbnails.py:40-59` stores the full-resolution image (byte-cap only, no
downscale) in a `public = true` bucket (`supabase/migrations/20260731120000_reel_cover_bucket.sql`),
keyed by the Instagram shortcode itself (`backend/pipeline/cache.py:19-26`) — guessable from
any reel URL — in a global cache shared across all users. Anyone can fetch our permanent
copy of any reel cover we've ever scraped, bypassing Instagram's expiring signed URLs.
Raises both creator-DMCA and Meta-platform exposure.
Roadmap: downscale to true thumbnails on ingest → consider signed URLs / non-public bucket →
per-item removal script (takedown-request sized, replacing bucket-nuke-only). B5 above is
the interim mitigation.

## D. Verified clean (evidence-based — don't re-litigate)

- No PII in backend logs (all 75 logger calls + non-test prints read); SSE `?token=`
  access-log leak already fixed (`log_redaction.py`, filter confirmed installed).
- OpenAI tracing disabled at all 4 Agents-SDK call sites; no env override re-enables it;
  user identity never sent to OpenAI.
- mem0 calls `user_id`-scoped at every site; no cross-user retrieval path found.
- No secrets in repo or client bundle; `.env.example` placeholders only; service-role key
  server-side only.
- Feedback table RLS owner checks intact; no auth bypass for the Aster demo account
  (dev sign-in page is build-time dev-only).
- No fake testimonials; "no card anywhere" true; 1-lifetime-free-generation copy accurate
  everywhere; hotel booking correctly future-tense; live-map demo data is real pipeline
  output; `a01e6cc` beta disclaimers present (FinalCTA + footer).
- Mapbox attribution + wordmark render on all 3 map inits; fonts via `next/font/google`
  (OFL); no GPL/AGPL direct deps; Instagram references all nominative, no logo assets.
- Precision note if ever asked "does RLS enforce this": backend runs as `service_role`, so
  RLS is inert for backend-mediated writes — app-code owner checks (correct, spot-checked)
  are the guard there; RLS is load-bearing for the frontend's direct Supabase reads.

## E. Non-code items (outside the repo, ZH only)

1. **Business entity** — footer says "© 2026 Astrail · Singapore". If no Pte Ltd (or
   similar) exists, all exposure above is personal liability. Biggest single variable in
   this whole document.
2. **Roll the `cfat_` Cloudflare account API token** (flagged during domain setup, still
   open).
3. **Instagram scraping platform risk** (Meta ToS) remains a knowingly accepted risk per
   the 2026-08-02 launch-readiness audit; the mirror finding (C) raises its profile.
4. External claims not verifiable from code, flagged not doubted: "self-funded", the
   hackathon "2nd place / 1,000+ teams / USD 15,000 credits" line (on /classic's
   ProofSection).

---

*Provenance: four `astrail-reviewer` agents, 2026-08-06, zh worktree HEAD `a01e6cc`.
Verdicts: legal-pages FAIL (A1, B2, B4) · IP PASS-WITH-CONCERNS (A2, C, B5) · claims
PASS-WITH-CONCERNS (A3, B1, B3) · data-practice PASS-WITH-CONCERNS (A1, RLS note).
Full agent reports live in the session transcript of 2026-08-06.*
