# Astrail Landing — Session Handoff: Product-First Hybrid (2026-08-02)

> Paste the fenced block into a fresh session to continue the landing build.
> Supersedes `BUILD-KICKSTART.md` (that session happened; this is its outcome + what's next).

---

```
You're continuing the Astrail landing build mid-flight. Read this whole prompt, then confirm:
"Loaded. Product-first hybrid, hero locked, [N] open items." Don't redesign what's locked.

WHERE THE STORY STANDS (one paragraph of history):
The full 8-beat oryzo-style scroll story was BUILT twice on 2026-08-02: v1 sticky-sections
(rejected by Zhi Hao — "disjointed, no smooth transitions") and v2 "One-Stage" proof slice
(beats 0→2, seamless, verified). Then Zhi Hao made the right founder call: the all-metaphor
story hides the actual product until 75% scroll — a trust problem for a 25-seat self-funded
beta. PIVOT (locked): PRODUCT-FIRST HYBRID. Metaphor becomes seasoning, real UI becomes the
spine. Nothing was deleted; the story assets are parked for socials + a future /story page.

THE LOCKED PAGE SHAPE (Zhi Hao approved):
1. HERO (BUILT, KEEP AS-IS): Aster walks in from off-screen right onto an empty ivory stage,
   stops right-third, settles STANDING, then idle-loops forever (never freezes) — headline
   layer + waitlist CTA in code. Files: components/story/stage/{StoryStage,Beat0Layer}.tsx.
2. DIVE INTO THE PHONE (BUILT, RETARGET): the scroll-owned camera zoom into his phone
   (transformOrigin 51%/57%, blur+dissolve) currently lands on the POV feed clip — retarget
   it to land on REAL APP UI ("your feed becomes your itinerary"). Zhi Hao may instead keep
   1 beat of the POV clip first — HIS PENDING CALL, see open items.
3. HOW IT WORKS — real UI: paste reels → agents research → itinerary on map, told with real
   app screenshots/crops (NOT renders). Screenshots pending Zhi Hao's login (see open items).
4. LIVE MAP DEMO (COMPONENT EXISTS): components/story/StoryRevealMap.tsx — a real standalone
   Mapbox night map w/ TOKYO_TRIP numbered brass pins + route line. Reframe as an embedded
   "this is what you get" section. (Wrap in a positioned parent — mapbox css forces
   position:relative on its container.)
5. DEMO VIDEO section: Zhi Hao is recording a FRESH screen-capture himself; build the section
   with a swap-ready slot. (components/landing/DemoVideoEmbed.tsx exists as the old pattern.)
6. CTA: honest seats. SEATS in components/story/story-config.ts: SEATS_CLAIMED=0,
   BOARDING_OPEN=false → nav + hero already show "25 seats · boarding soon", waitlist
   (Tally, tallyFallbackUrl) is primary everywhere. NO INVENTED NUMBERS — flip BOARDING_OPEN
   at launch. At most ONE metaphor accent section (spark clip is the candidate).

ZHI HAO'S SCENE VERDICT (2026-08-02, decided — do not relitigate):
- CUT from the landing: phone-scroll POV clip AND the country-globes flythrough (his call,
  agreed rationale: both are SIMULATED product — fake screens/fake route-world erode the
  trust the pivot exists to build; character-only metaphor is fine, fake UI is not).
  The dive therefore lands DIRECTLY on real app UI, no intermediate feed beat.
- KEEP: hero walk-in + idle. Defaults unless he says otherwise: spark = the single
  metaphor accent; CTA mech-wave = soft keep as the warm bookend.

ZHI HAO'S REMAINING PENDING CALLS (do NOT decide for him):
- Screenshots: he was about to sign in (via gstack browser) so real app UI can be captured.
  Sign-in gotcha: Supabase email OTP rate-limits (~2-4/hr on default SMTP; often in spam) —
  "Continue with Google" is the reliable path. The FastAPI backend is NOT in the auth path
  (and one is likely already running: check `lsof -nP -iTCP:8000` before starting another).
  NEXT_PUBLIC_MOCK_AUTH=true exists as a data-less fallback (empty states only).
- His fresh demo video file, when recorded.

REPO STATE (branch zh, ALL landing work uncommitted):
- / = StoryStage (hybrid base) · /classic = old stacked landing (preserved, noindex)
- components/story/stage/* = the One-Stage engine (keep) · components/story/beats/* +
  StoryLanding.tsx = parked v1 sticky build (reuse StoryRevealMap; rest is reference)
- public/landing/*.webp = 12 optimized stills · public/landing/clips/*.mp4 = ~400MB RAW
  Seedance clips — MUST be compressed before any commit (no ffmpeg on machine/banned;
  use avconvert or a Node approach; decide at perf pass)
- Lenis installed + logged in .claude/docs/STACK.md (landing-scoped only, ZH-approved)
- Task list: #12 = the hybrid build · #9 mobile/reduced-motion · #10 QA/reviews/PR

HARD-WON GOTCHAS (respect these, they cost hours):
- Seedance: --generate_audio false avoids the boost-credit wall at any resolution.
  --end-image pins a clip's final frame to art. IDLE LOOPS: start-image = end-image = the
  PREVIOUS clip's TRUE last frame — extract it race-free in-browser (seek + verify
  currentTime, no timeout fallback; seeking a 50MB mp4 can take >1.5s and a timeout race
  hands you a mid-video frame). Then crossfade 350ms at the swap (residual re-synthesis
  shimmer ~70 on the pixel-diff scale where real motion is 200+).
- Browser caches mp4s by URL — bump ?v= query when replacing a clip file.
- motion v12: a MotionValue style whose INITIAL value equals the CSS default (opacity 1)
  can freeze and never update (scale on the same element keeps working). Start fades at 0,
  or toggle React state under an opaque cover.
- Unlayered CSS (story.css .story-copy z-index:3) BEATS Tailwind layered z-utilities —
  use inline zIndex for stage text layers.
- Screenshots race the Lenis+spring settle after programmatic scroll — probe DOM values,
  or wait, before trusting pixels.
- Verify in the real browser; show Zhi Hao options before locking looks; keep the copy
  spine + claims boundaries (no booking claims, "coming in the full launch" phrasing).

BUILD ORDER FROM HERE:
(1) his scene verdict + screenshots → (2) build sections 3–6 → (3) retarget the dive →
(4) mobile + reduced-motion pass → (5) clip compression → (6) /qa + astrail-reviewer +
Codex cross-review → (7) PR. Confirm each visual with Zhi Hao before locking.
```

---

*Session artifacts: memory note `astrail-landing-scroll-story` (updated with v1/v2/pivot
history + gotchas) · oryzo teardown: one fixed canvas (Gaussian splats + Rive), 63 screens —
grammar transfers, tech doesn't.*
