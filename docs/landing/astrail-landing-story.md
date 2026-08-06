# Astrail Landing — Story Pack v2 ("Aster's Cut")

> Single source of truth for the beta landing page: narrative, scroll choreography,
> Higgsfield shot list, and conversion mechanic. Supersedes the earlier ChatGPT-authored
> pack. Reference for both Higgsfield generation and the frontend build — one story, one place.
>
> Status: **direction locked 2026-08-02.** Character locked, launch mechanic locked (jetpack).
> Iterating scene keyframes shot-by-shot. See "Open tweaks" at the end.

---

## 1. What this page is

A scroll-driven, oryzo-style landing page for Astrail's **capacity-limited beta**. The beta
lets people test the **AI planning flow only** (paste reels → get a real, evidence-backed
itinerary on a 3D map). The full launch — specialised agents that compare, choose stays, and
**book via Travala MCP**, plus a more polished flow — is the *future vision*, never claimed as live.

**Conversion reality (drives every CTA):** the beta is self-funded, so it carries roughly
**25 seats**. The page is a *gated front door* — open seats go straight into the working flow;
once full, everyone else joins the **waitlist** for the next mission (and for the full launch).

**Aesthetic:** Pixar-clean **depth without clutter** — depth comes from light, gradient, a
ground plane and soft shadow, never from filling the frame. Warm and calm at the top, deepening
to cold-premium space at the payoff. The environment itself carries the warm→cold arc.

---

## 2. Cast (LOCKED)

**Aster — the Star Navigator** (fluffy Shiba Inu astronaut). The emotional protagonist and the
**user's surrogate**: he saves travel reels he loves until he's buried in inspiration he can't
act on — exactly the visitor's problem. Smart-navigator-first, warm-companion-second; curious,
slightly overprepared, proud of a clean route.

- **Canonical reference:** `docs/landing/assets/aster-canonical.png` — feed this into EVERY
  generated frame so the character never drifts.
- **Design:** real fluffy orange-and-cream Shiba fur (not smooth plastic); vintage brown-and-gold
  aviator **goggles resting up on the forehead** (no bubble helmet); detailed white-and-cream
  astronaut **spacesuit** with teal accent lines, black articulated joints, **black paw gloves
  with a teal paw-pad**, cream-and-black boots.
- **Belly emblem = the Astrail "A" mark** (`docs/landing/assets/astrail-logo-a.png`) — a metallic
  silver "A" with a shooting-star swoosh + four-point star. On hero shots, composite the clean
  SVG for crispness (it renders only approximately in AI).
- **Nav-pack** on his back = the **jetpack + route engine** (see launch, below).

**The mech — Astrail's planning engine (the vehicle Aster pilots).** A **boxy retro-TV
rectangular mecha**: cream-ivory body, a large rectangular cockpit window (the clear "bubble" is
the mech's — which is why Aster wears goggles, not a helmet), rounded paw-grabber arms, stubby
legs, a glowing star-collector capsule + gold star antenna on the back, and the **A-mark on the
front panel.** Canonical reference: `docs/landing/assets/mech-canonical.png`.

Aster wears his suit everyday; for the launch he is **scooped into the mech's cockpit** and
pilots it. (The earlier suit-jetpack idea is retired — the mech is the hero.)

**Signature ritual** (reusable across app loaders, chatbot, socials):
> **Catch the star. Store the star. Chart the trail.**

---

## 3. Story grammar (every visual maps to a product truth)

| Story element | Product meaning |
|---|---|
| Travel reel on the phone | Raw travel inspiration the user already saved |
| User's scroll = Aster's thumb flick | The visitor *is* Aster scrolling the feed (first-person merge) |
| Tap ❤️ → star | A place/idea extracted from a reel (the input model, as a gesture) |
| Clean stage fills with stars | The overwhelm — inspiration with no path |
| Mech scoops Aster up + vacuums the stars into its collector | Astrail rescues you and *collects/organizes* the scattered inspiration |
| Flight around the globe, placing stars | Route-building across real places |
| Constellation trail | A structured, connected itinerary |
| Globe hardens into the map | The metaphor resolves into real software |
| Numbered pins / route legs | Real itinerary stops and transport |
| 25 seats on the first flight | The capacity-limited beta |
| Second, fainter constellation | Future agents (Compare · Stay · Book) — *coming, not live* |

If a shot doesn't map to a product truth, cut it.

---

## 4. The storyboard — cold open + 7 beats, 3 acts

Pixar-clean cold open → warm stage & overwhelm (1–3) → Astrail steps in, the mech rescue-to-globe
spectacle (4–5) → real & ready (6–7). One continuous space that deepens as you scroll.

**Copy spine (confirmed 2026-08-02) — reading the headlines top-to-bottom must explain Astrail.**
Every frame carries words; vibes alone don't tell the visitor what Astrail is.

| Beat | Headline on screen |
|---|---|
| Cold open | **Turn the reels you saved into a route you'll actually take.** |
| Spark | **Every place you love — saved as a star.** |
| Overwhelm | **But a pile of saved places isn't a plan.** |
| Rescue / Collection | **Meet your navigator. It rounds up every place you saved —** |
| Around the globe | **— and connects them into a route that works.** |
| Reveal (real map) | **A real itinerary on a real map. Not another list.** |
| CTA | **Be one of the first 25 to fly the beta.** |

### Beat 0 — Cold Open (the Pixar moment) — `pre-scroll / 0–6%`
Clean minimal stage with soft depth (pale, gentle contact shadow, no props). The **Astrail
wordmark + slogan sit on the LEFT** (we read left→right). Aster **walks in from the RIGHT**,
absorbed in his phone — oblivious, not looking up. Pure brand + character, premium and restrained.
- Slogan: **Turn the reels you saved into a route you'll actually take.**
- Primary CTA visible immediately: *Start your first trail*

### Act I — Inspiration & overwhelm (clean minimal stage throughout)

**1 · The Scroll → first-person merge** — `6–20%`
Camera pushes in on Aster's phone. **His thumb flicks in sync with the user's scroll** — the
user's scroll input drives the reel feed. For this beat, the user *is* Aster. (oryzo "second-read"
delight.) Reels flow past under the thumb.

**2 · The Spark** — `20–30%`
A reel lights him up: ears rise, eyes flash to stars, he taps ❤️ — the reel peels off the phone
into a glowing star he catches.
- Copy: *One tap. One star.*  ·  The save-gesture **is** the product's input.

**2.5 · The Saving Frenzy** — `30–36%`
Pure back view, sitting: Aster **spams likes** with both paws whirling (motion-blur), a single
rising **line of love-hearts**, and puffy yellow+blue stars popping out and piling up — the
behavior escalates (one star → hundreds) and bridges straight into the overwhelm pile.
`assets/spam-likes.png`.
- Copy: *One's never enough. You save another. And another.*

**3 · The Overwhelm** — `30–44%`
He keeps saving. Physical puffy **star-cushions** (glowing yellow + blue) flood the floor and
**pile into a mountain that rises higher as the user scrolls** — the overwhelm compounding under
you. Aster sits half-buried, engulfed to his chest, weary done-with-it face. Tactile,
cozy-but-drowning; sets up the jetpack sweeping the whole pile at launch.
- Headline: **So much inspiration. No idea where to start.** (the pain, *felt*)

### Act II — Astrail steps in

**4 · The Rescue & Collection** ⭐ — `44–58%`  (the hero beat)
The **mech bursts through the star-mountain toward the viewer** (Hulk-through-a-wall energy —
goofy and thrilled, "Meet your navigator"). Then, extending from that same burst framing, the
**star-collector jar pops its lid open and vortexes the whole surrounding star-cloud into itself**
— the jar fills as the stars swirl in ("catch the star, store the star"). Then thrusters fire and
it **flies downward** in the scroll direction, first-person "you're riding in the mech too" feel,
on toward the globe. Frames: `assets/rescue-burst.png` (burst) → `assets/rescue-collect.png`
(jar-suction). The scoop / fill / fly are *motion* (image-to-video) between them.
- Copy: **Meet your navigator. It rounds up every place you saved —** (sentence finishes on Beat 5)
- Section mock: `docs/landing/section-rescue-mock.html`
- Copy: **Meet your navigator.**  ·  helpless → capable; relief exhale.

**5 · The Planet Journey (first-person POV)** — `58–74%`
**First-person chase-cam**: we ride just behind Aster's mech (its half-body + glowing
star-collector in the foreground), flying FORWARD through space as the **country-globes come out
of the screen** — Korea → Thailand → Singapore, each a soft-clay "tiny planet" packed with its
landmarks, growing and passing as the user scrolls (scroll = throttle). A teal **comet-trail**
streams ahead linking them. Each globe gets an HTML label (*Seoul · Day 1*, *Bangkok · Day 2*…).
Globes = `assets/globe-{korea,thailand,singapore,japan}.png` (soft claymation, Pocket-World
density, distinct palettes: KR autumn tan · TH tropical green+gold · SG white-grey urban · JP
sakura+Fuji).
- Copy: *— and connects them into a route that works.* → *Grouped by day. Mapped by place.*

### Act III — Real & ready

**6 · The Reveal (dive into Japan → the app)** — `74–88%`
The **Japan globe** (the destination) fills the view as the mech dives into it; a **cloud
transition** (whiteout wipe — the natural dark-space→bright-map bridge) clears onto the **real
Astrail Mapbox map** — the flight-trail becomes the real **route line**, the globes become
**numbered pins**, itinerary cards slide in. Live product UI, not video; appears before the final
quarter. (Real app ref: the Tokyo "Food Stops & a Snowy Escape" trip view.)
- Headline: **A real itinerary on a real map. Not another list.**

**7 · Board the Mission (warm bookend)** — `88–100%`
**Transition from Beat 6:** after the live map, Aster's mech **flies down slowly, lands softly,
and waves to the viewer** — he comes *to you* (personal, engaging; realised as Seedance motion
into the locked CTA pose). We settle back on the **warm ivory stage** — full circle to the cold
open. Star-collector full; the finished **constellation-route** arcs overhead; a fainter second
constellation (Compare · Stay · Book) teases *coming*. `assets/cta.png` (backdrop; form is HTML).
- Headline: **Be one of the first 25 to fly the beta.**
- *"We're self-funded, so the first flight carries just 25 explorers."*
- Open: **Claim a seat** ("17 / 25 claimed") → into the working flow. Full → **Join the waitlist**.

---

## 5. Video vs. live (the hybrid rule)

Higgsfield generates **character/emotion** shots only. The frontend owns **everything with text,
data, UI, or the real map** — never rely on generated video for interface detail or copy.
Text is always HTML/SVG on a layer *above* the visual (crisp, accessible, editable, responsive).

| Owned by Higgsfield (video) | Owned by frontend (live) |
|---|---|
| Aster walking in, scrolling, the spark, the overwhelm reaction | Wordmark + all copy, CTA, reel cards, star particles, star labels |
| The jetpack launch (shot 4) | Constellation line-drawing, scroll progress, thumb-scroll sync |
| Globe fly-by character passes | The real 3D Mapbox globe + map, itinerary cards, seat counter, waitlist form |
| Reveal pose / salute | Reduced-motion fallback |

The payoff (beats 6–7) is **the real running app**, not a render.

---

## 6. Higgsfield shot list

Generate as **separate shots**; do not force one long film into scroll timing. **Feed
`aster-canonical.png` as the reference on every shot** so the character stays locked. Keep the
detailed suit + teal accents; goggles **up** until shot 4, **down** after. Backgrounds stay
clean (depth-not-clutter); star swarms + particles are added live in code, not baked in.

0. **Cold open** — clean minimal stage, Aster walking in from the right absorbed in his phone,
   vast text-safe negative space on the left. Calm, premium.
1. **Phone scroll** — over-shoulder / close on the phone, thumb flicking, reels flowing (loopable;
   frontend syncs it to scroll).
2. **The spark** — close on his face: ears rise, eyes flash to stars, paw taps ❤️; a star lifts off.
3. **Overwhelm** — wide: tiny Aster slumped under a dense scattered starfield on the clean stage.
4. **Rescue launch** ⭐ — the mech bursts through the star-mountain, scoops Aster into the cockpit
   (goggles down), thrusters fire, flies downward toward the globe. The money shot; iterate most.
5. **Reveal pose / salute** — Aster small and steady beside the map, a proud approving nod to camera.

Pipeline per shot: generate a **keyframe image** (reference-locked) → **image-to-video**
(`seedance_2_0`) to animate. Locks the character before motion.

---

## 7. CTA + the 25-seat mechanic

- **Primary (seats open):** live counter → *Claim a seat* → straight into the live planning flow.
- **When full:** *Join the waitlist — next mission* + email capture.
- **Honest hook (on-brand, build-in-public fuel):** *"We're self-funded, so the first flight
  carries just 25 explorers."*
- **Future tease, claims-safe:** the faint second constellation — *Compare · Stay · Book* —
  labelled *"coming in the full launch,"* never as live.
- Waitlist form: email + next destination; one optional "hardest part of planning?" field.

---

## 8. Claims boundaries

Use: *"Astrail is building…"*, *"coming in the full launch"*, *"designed to support…"*.
Avoid until genuinely live and verified: "books your entire trip automatically" (Travala not
wired yet), "connect Instagram and we import every saved reel" (show paste/add-link), "guaranteed
best hotel price."

---

## 9. Page rules · accessibility · mobile

- Value prop + primary CTA visible **before the first scroll**.
- The **real product interface appears before the final quarter** (beat 6).
- Every animation explains a product idea or deepens Aster's personality — no decoration.
- Constellation-trail scroll progress indicator; the visitor always knows where they are.
- **Reduced-motion mode**: copy fully readable, scenes static, CTA always reachable if WebGL/video fails.
- Semantic headings, real HTML/SVG text — **never** bake copy into video.
- Lazy-load below-the-fold scenes; compress all generated assets.
- **Mobile** = five stacked scenes, lighter motion: 1. reel → star · 2. stage fills → overwhelm ·
  3. goggles down → jetpack · 4. globe → constellation → itinerary · 5. seat counter + CTA.

---

## 10. Assets (locked references)

- `docs/landing/assets/aster-canonical.png` — **canonical Aster** (feed into every frame).
- `docs/landing/assets/astrail-mascot-sheet.png` — full mascot style sheet (fur, suit detail).
- `docs/landing/assets/astrail-logo-a.png` — the Astrail "A" mark (belly emblem + wordmark).
- `docs/landing/assets/coldopen-hero.png` — cold-open keyframe (used in `hero-mock.html`).
- `docs/landing/assets/overwhelm-beat.png` — overwhelm beat (yellow+blue puffy star-mountain).
- `docs/landing/assets/mech-canonical.png` — **canonical launch mech** (boxy, Aster piloting).
- `docs/landing/assets/mech-ref-original.png` — original Stello mech sheet (shape reference).
- `docs/landing/assets/rescue-collection.png` — rescue via vacuum-vortex (ALT; superseded by burst).
- `docs/landing/assets/rescue-burst.png` — **rescue burst** (Hulk-through-the-star-wall, chosen direction).
- `docs/landing/assets/rescue-collect.png` — rescue collection (jar pops open, vortexes the star-cloud in).
- `docs/landing/assets/globe-korea.png` — Korea tiny-planet (autumn tan) — **the density standard**.
- `docs/landing/assets/globe-thailand.png` — Thailand tiny-planet (tropical green + gold temples).
- `docs/landing/assets/globe-singapore.png` — Singapore tiny-planet (white-grey urban + ~30% green).
- `docs/landing/assets/globe-japan.png` — Japan tiny-planet (sakura + Fuji + red) — **destination**.
- `docs/landing/assets/phone-scroll.png` — Beat 1 first-person POV (paws + phone, reels feed).
- `docs/landing/assets/spark.png` — Beat 2 spark (star-eyes, reel→star, Aster on right).
- `docs/landing/assets/spam-likes.png` — Beat 2.5 saving-frenzy (pure back, hearts line, star pile).
- `docs/landing/assets/cta.png` — Beat 7 CTA (warm bookend, mech waves, full collector).

---

## 11. Open tweaks (living)

- [x] Lock canonical Aster (fluffy astronaut, goggles, A-belly, nav-pack). ✅ 2026-08-02
- [x] Launch mechanic = **boxy mech rescue launch**; suit-jetpack idea retired. ✅ 2026-08-02
- [x] Lock the boxy launch mech — A-logo front, Aster piloting. ✅ `assets/mech-canonical.png`
- [x] Re-shoot cold open + compose hero (text layer over frame). ✅ `docs/landing/hero-mock.html`
- [x] Overwhelm beat — yellow+blue puffy star-mountain (grows on scroll). ✅ `assets/overwhelm-beat.png`
- [x] Rescue reshaped → **Hulk-burst + arm-vacuum**; burst frame locked + copy composed. ✅ `assets/rescue-burst.png`, `section-rescue-mock.html`
- [x] Confirmed the **copy spine** (headlines that explain Astrail end-to-end). ✅ 2026-08-02
- [x] Locked the **4 country-globes** — soft-clay tiny-planet, Pocket-World density (KR/TH/SG/JP). ✅
- [x] Beat 5 = **first-person POV flythrough** (ride behind mech, globes approach); Beat 6 = dive into Japan → **cloud transition** → real Mapbox. ✅ (concept only — final scene not shot)
- [x] **All beat keyframes shot** (cold-open · phone-scroll · spark · saving-frenzy · overwhelm · rescue-burst · 4 globes · POV concept · CTA). ✅ 2026-08-02 — art set complete.
- [ ] **BUILD PHASE (fresh session):** assemble POV flythrough (real 4 globes + labels + Japan→cloud→app); wire the map→CTA descent (mech flies down, lands, waves); animate keyframes (Seedance); code the scroll page (React/Next, scroll-scrubbed + sticky, text as HTML layer).
- [ ] Shoot the "fly downward toward the globe" follow-frame (mech descending, scroll direction).
- [ ] Decide globe treatment: stylised space-globe that morphs into the real Mapbox globe, vs.
      real Mapbox globe throughout beats 5–6.
- [ ] Confirm exact seat number (25?) and whether the counter is live or set at launch.
- [ ] Warm-vs-cool palette for the cold open (cozy warm vs. cool-premium).
- [ ] Tune hero typography — fonts + wordmark (drop in the real A-logo SVG). Deferred per ZH.
