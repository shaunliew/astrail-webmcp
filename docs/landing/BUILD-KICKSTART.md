# Astrail Landing — Build Kickstart (paste into a fresh session)

> Copy everything in the fenced block below into a new session (running the **Fable** model) to
> start the build phase. The design + all art are already done; this session is **pure build**.

---

```
You're picking up the Astrail landing-page build. The STORY and ALL ART are already designed and
locked in a previous session — your job is to BUILD it, not redesign it. Do NOT re-invent the
concept, characters, or beats.

STEP 0 — LOAD CONTEXT FIRST (do this before anything else):
1. Read the single source of truth: docs/landing/astrail-landing-story.md (full narrative, the
   8-beat storyboard, copy spine, transitions, CTA mechanic, accessibility/mobile rules).
2. Read the memory note "astrail-landing-scroll-story" (decisions + what's locked).
3. Look at the locked art in docs/landing/assets/ (Aster, mech, A-logo, 4 country-globes, and one
   keyframe per beat) and the two composed HTML mocks: docs/landing/hero-mock.html and
   docs/landing/section-rescue-mock.html (open them to see the intended text-over-visual layering).
Then confirm back: "Loaded. Building Astrail landing, [N] beats, art locked," and propose a build
plan before writing code.

WHAT IT IS:
An oryzo.ai-style scroll-animation landing page for Astrail's capacity-limited beta (~25
self-funded seats → waitlist overflow). Beta = test the AI planning flow only; hotel booking via
Travala = FUTURE vision, never claim it as live. Core message the page must teach by the end:
"Astrail turns the travel reels you saved into a real itinerary on a real map."

THE BEATS (full detail in the doc): cold-open (Aster walks in on phone) → phone-scroll (first-
person, scrolling reels) → spark (star-eyes, reel→star) → saving-frenzy (spam-likes) → overwhelm
(buried in a yellow+blue puffy star-mountain that grows on scroll) → rescue-burst (mech Hulk-bursts
the pile toward you; then its star-collector JAR pops its lid open and vortexes the surrounding
star-cloud in; then flies down) → planet-journey (FIRST-PERSON POV: ride
behind the mech, fly past Korea/Thailand/Singapore tiny-planet globes, comet-trail links them) →
reveal (dive into the Japan globe → cloud whiteout transition → the REAL Mapbox app) → CTA (mech
flies down, lands, waves; warm bookend; 25-seat scarcity).

NON-NEGOTIABLES:
- TEXT IS A CODE LAYER. Every headline/label/CTA is real HTML/SVG on top of the visuals — NEVER
  baked into video. Crisp, accessible, responsive, editable. (Copy spine = in the doc.)
- The Beat-6 reveal is the REAL product — live Mapbox GL map (this repo already has the Astrail
  trip/map view), not a rendered image. Illustrated globe → cloud whiteout → real map.
- Scroll drives everything: scroll position → a 0→1 progress number → drives both the visual
  playhead AND when each line of text appears. First-person beats: user's scroll = Aster's action.
- Reduced-motion fallback required (copy readable, scenes static, CTA reachable if WebGL/video
  fails). Mobile = 5 simplified stacked scenes (see doc).

HOW TO ANIMATE THE VISUALS (Higgsfield — use the higgsfield-generate skill):
- Stills already exist as keyframes. Animate each beat with image→video: model seedance_2_0,
  feed the locked keyframe as --start-image + a motion prompt → ~5–10s silent clip PER BEAT (not
  one long film). Frontend scrubs/plays clips on scroll.
- For new/consistent stills use nano_banana_pro and FEED the locked reference assets
  (aster-canonical.png, mech-canonical.png, the globes) so nothing drifts. Known quirk: goggles
  tend to render UP even when prompted down.
- Still to assemble as art: the POV flythrough scene using the real 4 globes + the two motion
  transitions (Japan→cloud→map, and map→CTA descent/land/wave).

TECH / WHERE IT LIVES:
- This is the Astrail repo (Next.js 15 + React 19 + Tailwind v4 + Mapbox GL, Vercel frontend).
  Decide with me: a new route in the Next app (likely) vs standalone. Follow the repo's CLAUDE.md
  and BUILD-LOOP conventions.
- Scroll tech: scroll-scrubbed <video> and/or sticky sections with GSAP ScrollTrigger or Framer
  Motion, Lenis for smooth scroll, WebGL/Three or the existing Mapbox for the globe→map handoff.
- Lazy-load below-the-fold clips; compress assets; value-prop + CTA visible before first scroll.

CTA MECHANIC:
Live "17 / 25 seats claimed" counter → "Claim a seat" (into the working flow); when full →
"Join the waitlist." Honest hook: "self-funded, first flight carries just 25 explorers." Faint
second constellation teases Compare · Stay · Book as "coming." No booking/price-guarantee claims.

WORKING STYLE (important):
- Creative/visual decisions are the founder's (Zhi Hao, frontend owner) call — present options,
  show visuals, and ASK before locking a scene or a look. Don't declare-and-lock unilaterally.
- The COPY is the point, not just vibes: every beat must carry words that advance "what Astrail
  is." Keep the copy spine intact unless he changes it.
- Verify in the real browser (screenshot/QA), don't just assert "done."

FIRST DELIVERABLE: after loading context, propose (a) where the page lives in the repo, (b) the
build sequence (scaffold → one beat end-to-end as a vertical slice → then the rest), and (c) which
scroll library. Get a nod, then build the first vertical slice (cold-open → phone-scroll) as proof.
```

---

*(Generated 2026-08-02 at the end of the design session. If beats/art changed after this date,
`astrail-landing-story.md` is authoritative.)*
