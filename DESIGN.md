---
name: Astrail
tagline: Astrail turns scattered travel inspiration into the route you actually take.
system: Night & Daybreak
status: canonical
supersedes: docs/DESIGN-DRAFT.md
implemented_in: frontend/app/globals.css (Night & Daybreak token block, "approved 2026-07-15")
shipped_across: 9e85059 (Phase 0) → 87bc3c7 (Phase 4), audited in 52cf367
last_verified: 2026-07-20
---

# Astrail — Design System

> This is the canonical design document. It describes **what is implemented**, cites the file
> that implements it, and marks every place where intent and code disagree in one section
> ("Open gaps") rather than scattering caveats through the prose.
>
> Rules here are not aspirations. Each one is traceable to a line of shipped code or to the
> stated intent of a commit that shipped. Where a rule is written down but not implemented,
> it lives in Open gaps — not in Do/Don't.

---

## 1. Identity

Astrail is an AI-native travel planner. The user pastes saved travel Reels; an agent pipeline
extracts places, verifies them, and returns a mapped, day-by-day itinerary with the reasoning
attached.

- **Positioning line**, verbatim — `README.md:3`:
  > Astrail turns scattered travel inspiration into the route you actually take.
- **The name** — `README.md:9-13`: *Astrail = Astra + Trail*, meaning **star path, guided route**.
- **Shipped product voice** — `frontend/app/layout.tsx:25-27`:
  > Astrail · Plan trips from your saved travel Reels
  >
  > Paste your saved travel Reels. Astrail extracts the places, verifies them, and builds a
  > day-by-day itinerary with the reasoning attached. Beta opening soon.

The interaction metaphor, from `docs/PRD.md:44`, is a pipeline the UI should make legible at
every step — not decoration applied afterward:

```text
scattered inspiration -> verified places -> connected route -> saved trail
```

`docs/PRD.md:37` sets the boundary the visual language must not cross: stars, trails,
constellations, luminous route lines and dark-sky atmosphere are permitted, but the result
**must remain a trustworthy travel planning product.**

---

## 2. The two worlds

The system has two lighting states, and they are assigned by *what the user is doing*, not by a
theme toggle. `docs/PRD.md:449-470` (§13 Map Experience Direction) specifies exactly two:
"dusk/night lighting during inspiration and generation" and "readable trip exploration lighting
after generation."

| World | User is doing | Surfaces | Scope class |
|---|---|---|---|
| **Night** (Astra) | Dreaming — sign-in, onboarding, pasting Reels, trip brief, generation | Indigo-shifted darks, starlight text | `.app-shell` (`frontend/app/globals.css:344`) |
| **Daybreak** (Trail) | Holding the plan — trip workspace, itinerary, trips list, settings | Paper surfaces, ink text | `.paper-scope` (`frontend/app/globals.css:379`) |

`frontend/app/app/layout.tsx:5` wraps the entire `/app` route tree in `.app-shell`. The landing
page at `/` deliberately keeps the untouched `:root` palette — the file comment at
`globals.css:342-343` states this: *"The landing keeps the :root values untouched."*

`.paper-scope` is not a second theme; it is a nested remap applied to reading surfaces inside
the night shell (`globals.css:379-395` rebinds `--starlight` to ink, `--brass-bright` to
`--brass-deep`, and the semantic triplet to its day variants). A paper panel floating on a night
map is the intended composition, not a bug.

**One thread runs through both worlds: brass** — the star-gold of the trail. It is the only
brand accent. Bright on night (`--brass-bright: #EFC98D`), deep on paper
(`--brass-deep: #8A6023`).

---

## 3. Color

All tokens below are declared in `frontend/app/globals.css:16-48`, in a block explicitly
commented `Night & Daybreak system (approved 2026-07-15)`. Read that block as the source of
truth; this table is a description of it.

**Night world** — never neutral black.

| Token | Value | Use |
|---|---|---|
| `--night-void` | `#0A0B14` | Page ground, map frame |
| `--night-deep` | `#111322` | Recessed areas, inputs |
| `--night-surface` | `#191C2E` | Cards and panels (always with `--shadow-night`) |
| `--night-line` | `rgba(200, 205, 255, 0.1)` | Hairlines — cool-tinted, not grey |
| `--starlight-bright` | `#F7F3E8` | Primary text |

**Daybreak world.**

| Token | Value | Use |
|---|---|---|
| `--paper-0` | `#FBF8F1` | Cards |
| `--paper-1` | `#F3EEE2` | Page ground |
| `--paper-line` | `rgba(26, 24, 16, 0.08)` | Hairlines |
| `--ink-day` | `#1A1810` | Primary text |

**Brass — the only accent.**

| Token | Value | Use |
|---|---|---|
| `--brass-bright` | `#EFC98D` | Text and glow on night surfaces |
| `--brass` | `#C9974E` | Trail core, fills, large marks |
| `--brass-deep` | `#8A6023` | Text on paper (clears AA at small sizes) |
| `--brass-glow` | `rgba(201, 151, 78, 0.28)` | Halos, pulses, active-state washes |

**Brass is concentrated, not spread.** Per screen, brass belongs to at most: the route trail,
the active state, the primary action, and status pulses. `--brass` (`#C9974E`) is not a
small-text color — use `--brass-deep` on paper and `--brass-bright` on night.

**Semantic states ship as night/paper pairs and are never color-only** (`globals.css:32-38`):

| Token | Night | Paper | Meaning |
|---|---|---|---|
| `--ok` / `--ok-day` | `#7BC9A6` | `#2E7D5B` | Verified place, route ok, trip complete |
| `--warn` / `--warn-day` | `#D9A441` | `#9A731F` | Long transfer, saved with gaps, skipped stage |
| `--fail` / `--fail-day` | `#D0705F` | `#A8453A` | Failed reel, no route, generation failed |

Every semantic color ships with a label or icon. `EvidenceChip.tsx:19-20` is the pattern: the
chip carries a text label *and* a percentage, never a bare colored dot.

Contrast is a shipped constraint, not an aspiration. `52cf367` raised `--faint` from `0.45→0.55`
(night) and `0.42→0.55` (paper) because "the paper captions were ~2.6:1"; the inline comments at
`globals.css:361` and `globals.css:383` record the reason at the point of change.

---

## 4. Typography

Three faces, loaded in `frontend/app/layout.tsx:5-22`: **Instrument Serif** (display), **Geist**
(UI), **JetBrains Mono** (evidence).

| Role | Class | Face | Where |
|---|---|---|---|
| Display | `.type-display` | Instrument Serif | Trip titles, day headings, section headers, stat numerals |
| UI | `.type-body` | Geist | Body and secondary text |
| Label | `.type-label` | **Geist inside the app** (see below) | Form labels and data captions only |
| Evidence | `.type-evidence` | JetBrains Mono | Provenance only |

### `.type-label` is sans inside the app — do not "fix" this back

This is the single most misread rule in the system, so it is stated explicitly.

`:root` declares `.type-label` as JetBrains Mono (`globals.css:93-97`). That declaration lives in
`@layer utilities` and applies **only to the landing page**. Inside the app it is overridden:

```css
/* globals.css:362-366 */
/* Rule 03: inside the app, UI labels are sans — mono is reserved for evidence. */
.app-shell .type-label {
  font-family: var(--font-geist), system-ui, sans-serif;
  font-weight: 600;
}
```

Because `.app-shell` is declared **outside** any `@layer`, it wins over the layered utility
regardless of specificity. The comment at `globals.css:342` documents that this is deliberate:
*"Unlayered on purpose: must win over @layer utilities (.type-label font swap)."*

**The class name still reads "label = mono". It is not.** Reading `:root` alone gives the wrong
answer. If you are about to make app labels monospace because the `:root` rule says so, stop —
you are reverting Rule 03.

### Mono means provenance

```css
/* globals.css:463-464 */
/* Mono = provenance. The only place monospace is allowed inside the app. */
.type-evidence { font-family: var(--font-jetbrains-mono), ... }
```

Monospace appearing on screen is a signal with one meaning: **this is verbatim data from a
source.** It is used in seven components today — `EvidenceChip`, `TradeoffPanel`,
`InspirationTray`, `TripBriefReview`, `SavedReelsInbox`, `CountryTrays`, `DayOverview` (the
weather source tag) — and `SettingsView` composes `EvidenceChip` for the memory receipt.
Adding mono anywhere that is not provenance dilutes the signal to zero.

### Quoted source text is italic serif — at display sizes only

Resolved from Open gap G2 (2026-07-20, this branch). A verbatim reel/user quote renders as
an italic **Instrument Serif** blockquote over the brass quote-bar — the voice of the
source, not the UI (`PlaceIntelPanel.tsx`). The display face never drops below 18px
(`docs/DESIGN-DRAFT.md` §3), so the serif treatment applies only where the quote is a focus
surface; compact caption-size previews (`ItineraryCards.tsx`, 12px) keep sans-italic with
the same brass bar. The bar + italics are the constant; the face follows the scale.

### Uppercase tracked micro-labels are reserved

`52cf367` states the rule in its own commit body: *"uppercase tracked micro-labels are now
reserved for form labels and data captions only."* Section headers are serif sentence-case
(`.type-display`). See §10 for the worked example.

---

## 5. Geometry, surface, light

**Radius:** `--radius-card: 8px`, `--radius-chip: 6px`, pill `9999px`
(`globals.css:39-40`, `409`). There is no `--radius-pill` token; pills are literal.
*Shipped code does not fully hold this line — see Open gaps G3.*

**Depth comes from light, not lines.** Surfaces float on a shadow stack with an inset top
highlight, over a 7–10% alpha border:

```css
/* globals.css:41-48 */
--shadow-night:
  inset 0 1px 0 rgba(247, 243, 232, 0.07),   /* the light source */
  0 1px 2px rgba(0, 0, 0, 0.55),
  0 8px 28px rgba(0, 0, 0, 0.4);
```

**"The lights are on."** Every dark screen has a light source. `.app-shell`
(`globals.css:353-357`) carries two ambient radial gradients — a brass wash at the top and a
nebula-indigo bloom off-center — over `--night-void`. Dark is a night sky, never a basement.
Never a flat neutral grey ground.

---

## 6. Motion

**Only live states animate.** This is the system's motion ethic and it is written into the CSS:

```css
/* globals.css:492-493 */
/* Status dot: color carries the state's tone; ONLY live states animate —
   a glowing pulse on a finished trip is motion telling a lie. */
```

`.pulse-dot--live` and `.astronaut-trail--waiting` (the mascot's flowing trail) are the only
animating state classes, and both mean the same thing: something is in flight right now. `ok`,
`warn` and `fail` are static semantic colors. The rule is mirrored in the presenter layer —
`frontend/lib/trip/trip-presenters.ts:31-32`:

```ts
// Tone drives the status dot: 'live' is the only tone that may animate —
// pulse means in-progress, never "saved" (a finished trip does not breathe).
```

Motion is state, not decoration. If a thing is finished, it holds still.

**Easing.** The one deliberate easing decision in the system is `cubic-bezier(0.16, 1, 0.3, 1)`
on `.pin-land` (`globals.css:472`) — `52cf367` shipped it as *"pin-land easing loses the
bounce."* Note this is a single inline value, **not a token**: there is no `--ease-*` variable,
and no other rule uses this curve. Treat it as the reference curve for new entrance motion.

**`prefers-reduced-motion` is honored** (`globals.css:533-560`): decorative drift, route draw,
`pin-land` and `pulse-dot--live` all resolve to `animation: none`; panel and pin transitions
resolve to `none`. Any new animation must be added to that block.

---

## 7. The evidence chip — the product's native primitive

This is the component the rest of the system exists to support, and the draft never named it.

Astrail's differentiator is engineering guardrail #1: **no hallucinated places.** Every place
carries evidence, and the UI's job is to make that inseparable from the claim.

**Contract:** *a claim and its evidence render together, never separately.* A place name, a
route leg, a hotel suggestion, or a weather note may not appear on screen without its evidence
affordance adjacent to it. There is no "details" view where the provenance lives instead.

The data shape is fixed by the backend and mirrored in
`frontend/lib/trip/backend-types.ts:47-54` (mirroring `backend/models/place.py`):

```ts
export type TripPlaceEvidence = {
  confidence: number
  source_url: string | null
  quote: string | null      // primary verbatim reel/user quote
  quotes: string[]          // all merged-source quotes (dedup flywheel)
  rationale: string | null  // agent_suggested rationale
  evidence_kind: EvidenceKind
}
```

`EvidenceKind` (`backend-types.ts:30-33`) is a **closed union** — it is the product's evidence
vocabulary, and the UI must render all nine. `EvidenceChip.tsx:3-13` holds the shipped
enum→English map, which is the canonical wording:

| `evidence_kind` | Renders as |
|---|---|
| `reel_quote` | Reel |
| `requested_by_you` | You |
| `suggested_by_astrail` | Astrail |
| `research` | Research |
| `mapbox_route` | Mapbox |
| `open_meteo` | Weather |
| `travala_hotel_search` | Travala |
| `memory_preference` | Memory |
| `inferred_default` | Default |

**Rendering rules**, as implemented in `EvidenceChip.tsx:18-31`:

- `.type-evidence` mono at 10px, `--radius-chip`, `--chip-bg` ground.
- Kind label uppercase semibold in `--brass-bright` — this is a sanctioned brass use.
- Confidence renders as a rounded percentage, always present.
- `source_url` renders as a dotted-underline "source" link, `target="_blank"` +
  `rel="noopener noreferrer"`, and is omitted entirely when null — never a dead link.
- A verbatim `quote`, when present, renders adjacent (see `PlaceIntelPanel.tsx`) with a
  brass left bar and italics — the voice of the source, distinct from the UI's own voice.
  At display sizes (>=18px) the quote is serif (`type-display`); below that, sans-italic
  (see §4, "Quoted source text").

New screens must compose this component rather than inventing a local provenance affordance.

---

## 8. Voice

- **Raw enums never render.** Every backend enum has a shipped English map:
  `GenerationProgress.tsx:5-21` (`STAGE_LABEL`), `trip-presenters.ts:17-24` (`STATUS_LABEL`),
  `EvidenceChip.tsx:3-13` (`KIND_LABEL`). `saved_with_gaps` renders as "Saved with gaps".
- **Stage copy is plain and progressive**, and states what Astrail is doing on the user's
  behalf: "Scraping Reels", "Resolving your requests", "Mapping verified places", "Writing your
  days" (`GenerationProgress.tsx:5-21`).
- **Empty states use the product's own vocabulary**, not generic UI copy —
  `TripsList.tsx:45-51`:
  > No trails yet. Your saved trips will land here.
  >
  > [ Plan your first trip ]

  "Trails", not "trips"; "land here", echoing pins landing on the map. Every empty state pairs a
  sentence with exactly one action.
- **Disclosure is a feature.** Preference sources, inferred assumptions, and gaps are stated
  plainly. `TripBriefReview.tsx:92-94`: *"Check the details Astrail will use before it starts
  building your route."* Trust comes from showing the work in a traveler's words.

---

## 9. Map

The map is the core product surface (`docs/PRD.md:451`).

- **Style:** `mapbox://styles/mapbox/standard` (`docs/PRD.md:455`), globe projection.
- **Lighting is driven by product state**, per PRD §13. Generation runs at `night`
  (`GenerationScene.tsx:50`); the saved trip is explored at `dawn` (`TripMap.tsx:46`, with the
  reasoning in the comment above it). *These are two separate map instances, not an animated
  transition — see Open gaps G1.*
- **Constellation pins** (`globals.css:404-415`): dark disc, 1.5px `--brass-bright` ring, brass
  numeral, `--brass-glow` halo ring at 6px spread.
- **Pins land as places verify** — `.pin-land` (`globals.css:471-479`) scales in from 0.2 with a
  brass glow. This is the "time to first mapped value" beat (PRD §16).
- Map information must also exist in the itinerary list. The map is never the only channel.

---

## 10. Worked example: breaking vs. following the rule

Both of these are `<h2>` section headers, in the same component, twelve lines apart.
*(Historical: the violation below was fixed by `c805e16` — the example is kept because it is
the clearest statement of the rule.)*

**Broke the rule** — `frontend/components/settings/SettingsView.tsx:55` before `c805e16`:

```tsx
<h2 className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)]">
  Using your saved travel preferences
</h2>
```

**Follows the rule** — `frontend/components/settings/SettingsView.tsx:67`:

```tsx
<h2 className="type-display text-lg text-[var(--starlight)]">Astrail learned:</h2>
```

Two structurally identical headers; two generations of the system in one file. The second is the
corrected post-audit treatment. `52cf367` swept exactly this pattern — its commit body reads
*"Kill the eyebrow grammar: workspace Section headers + Tradeoffs heading go serif sentence-case
(15px ink) — uppercase tracked micro-labels are now reserved for form labels and data captions
only"* — but its file list covers `sign-in`, `InspirationTray`, `DaySelector`,
`OrchestratorSummary`, `TradeoffPanel`, `TripWorkspace`, `TripCard` and `trip-presenters`.
**`SettingsView.tsx` was never touched.** Line 55 is not a different opinion; it is a screen the
sweep missed.

`frontend/components/create/TripBriefReview.tsx:91` shows the same screen type done right:

```tsx
<h2 className="type-display text-3xl text-[var(--starlight)]">Review your trip brief</h2>
```

The uppercase tracked micro-label is still correct one level down, on **data captions** —
`TripBriefReview.tsx:99` labels a field group `Reels ({reels.length})` in exactly that style.
The rule is about which role the treatment marks, not about banning the treatment.

*(Fixed by `c805e16`: both headers in `SettingsView.tsx` are now `type-display` sentence-case.)*

---

## 11. Do / Don't

Every rule below is a rule this repo has already stated, with the line that states it.

### Do

- **Concentrate brass.** Trail, active state, primary action, status pulse — that is the budget.
  `--brass-bright` on night, `--brass-deep` on paper (`globals.css:29-31`, `:381`).
- **Reserve mono for provenance.** `.type-evidence` only (`globals.css:463`).
- **Use sans for app labels.** `.app-shell .type-label` is Geist 600 (`globals.css:362-366`).
- **Use serif sentence-case for section headers** (`52cf367`; `TripBriefReview.tsx:91`).
- **Stay on 8 / 6 / pill.** `--radius-card`, `--radius-chip`, `9999px` (`globals.css:39-40`).
- **Build depth from light** — inset highlight + shadow stack, borders at 7–10% alpha
  (`globals.css:41-48`, `:370-375`).
- **Keep a light source on every dark screen** (`globals.css:353-357`).
- **Ship semantic color with a label or icon** (`EvidenceChip.tsx:19-20`).
- **Compose empty screens** — a sentence in the product's vocabulary plus exactly one action
  (`TripsList.tsx:43-52`).
- **Render evidence with the claim**, via `EvidenceChip` (§7).
- **Translate every enum to English** (`GenerationProgress.tsx:5-21`,
  `trip-presenters.ts:17-24`).
- **Register new animation in the reduced-motion block** (`globals.css:533-560`).

### Don't

- **Don't animate anything that isn't live.** *"A glowing pulse on a finished trip is motion
  telling a lie"* (`globals.css:493`).
- **Don't make app labels mono** because `:root` says so — that is Rule 03 reverted
  (`globals.css:362`).
- **Don't put brass on body text or hairlines.** Borders and labels are not accent surfaces.
- **Don't use `--brass` (`#C9974E`) for small text.** It is a fill and trail color.
- **Don't introduce a fourth radius.** Every live surface renders 8 / 6 / pill as of
  2026-07-20 — see G3 for the six inert `rounded-xl` class names that remain.
- **Don't use pure black or neutral grey darks.** Night is indigo-shifted (`globals.css:18-20`).
- **Don't render a raw enum string.**
- **Don't ship a bare colored dot** as the only carrier of a semantic state.
- **Don't leave an empty screen as content-top-left-plus-void.**
- **Don't add decorative effects that reduce map readability** (`docs/PRD.md:449-470`).
- **Don't render a place, leg, or suggestion without its evidence** (guardrail #1).

---

## 12. Open gaps

Everywhere the written system and the shipped code disagree — or did. Resolved gaps stay
listed with their resolving commit, because each one records a decision the system argued
about; the open ones name both sides and what would change.

**G1 — RESOLVED. The signature moment now ships.**
Implemented 2026-07-20 on `feat/saved-reels-arc-c-frontend`. `docs/DESIGN-DRAFT.md:18-21`
calls the night→dawn relight the product's signature moment and §6.3 specs a *"2s map relight
night → dawn"*; both now hold.

**What the shipped architecture is.** One Mapbox instance lives in `frontend/app/app/layout.tsx`
via `frontend/components/map/MapProvider.tsx` — the only common ancestor of both sides of the
`router.push` handoff. `GenerationScene` and `TripMap` no longer own instances; they drive the
shared one. The relight fires on the SSE `result` event in *both* generation flows
(`CreateTripFlow.tsx` and `SavedReelsFlow.tsx` — there are two, which the original writeup of
this gap missed). `prefers-reduced-motion` gets duration 0: the end state, not the journey.

**The open question is answered: Mapbox animates the preset change — it does not snap.**
Traced through the installed `mapbox-gl@3.24.0`: `setConfigProperty` →
`updateConfigDependencies` → `ambientLight/directionalLight/fog.updateConfig` →
`_transitionable.setTransitionOrValue` → `transitioned(parameters, prior)`, i.e. lighting rides
the same Transitionable→Transitioning interpolation machinery as any other transitionable style
property. It honours the style's `transition` spec, which defaults to **300ms**. So a cross-fade
comes for free, but *not* the specced 2s — `setConfigProperty` takes no duration argument. The
lever is `map.style?.setTransition({ duration, delay })` (`map.style` is a public typed
property), applied before the preset change. Caveat: this is **source-level evidence, not a live
observation** — there was no Mapbox token in the worktree, so the relight was never watched
running. Only *transitionable* properties interpolate; config-dependent layer paint is
re-evaluated and any discrete/enum-driven values will pop. Lighting and fog do interpolate.

**Two things the architecture alone did not fix, both since handled.** `TripWorkspace`'s
loading state was a full-bleed takeover, so the relight would have played out behind a spinner
even with a persistent instance — loading and still-generating now hold the map and float their
message over it. And because the map is built lazily, a fast `result` can beat the Mapbox bundle;
construction used to re-apply the acquiring route's preset and strand the map on night.

**Cost control.** The Mapbox bundle is imported lazily inside the provider. A static import put
1.7MB into the shared layout chunk (measured: `/app/layout` 343kB → 2071kB) that `/app/trips` and
`/app/settings` would download for a map they never show; `next build`'s size table did not
surface it. The WebGL context is likewise built only on first acquire.

**G2 — resolved (2026-07-20): serif won, scale-gated.** The draft's reasoning ("the voice
of the source, not the UI") is only satisfied by a face change — italic Geist is still the
UI's voice, slanted. But the draft also gives the display face an 18px floor, which the
12px card previews cannot meet. Both rules survive: serif at display sizes
(`PlaceIntelPanel.tsx`), sans-italic below (`ItineraryCards.tsx`), brass bar always. Rule
now lives in §4.

**G3 — resolved on every live surface (2026-07-20).** "8 / 6 / pill and nothing else" now
holds everywhere it renders. The three buttons genuinely drawing 12px (`CreateTripFlow`,
`sign-in` ×2) went to `rounded-lg` (8px, the button idiom the rest of the app already used);
`TripWorkspace`'s 16px panel corners went to the card token; and the inventory had missed a
live **fourth** radius — `ItineraryCards`' source badge shipped bare `rounded` (4px), now the
chip token. Deliberately untouched: the six `rounded-xl` uses sitting on `.surface`, where the
unlayered `.app-shell .surface` / `.paper-scope .surface` rules force
`border-radius: var(--radius-card)` and win over the layered utility — those render 8px today,
so rewriting them changes nothing but diff noise. They remain the one cosmetic leak: inert
class names that would pop to 12px only if the `.surface` radius rule were ever removed.
`rounded-lg` (34 uses) remains "right value, bypasses the token."

**G4 — resolved (2026-07-20): `tabular-nums` where numerals move or align, not everywhere.**
The draft's "all stats, durations, distances" over-reaches: numerals set in `.type-evidence`
(JetBrains Mono — confidence percentages, coordinates) are fixed-width by construction, and a
lone static numeral in prose gains nothing. Applied where it is load-bearing: the workspace
stat grid (`OrchestratorSummary.tsx`), transport leg durations/distances
(`TransportStrip.tsx`), the generation heartbeat's elapsed seconds
(`GenerationProgress.tsx`), and the sign-in resend countdown (`sign-in/page.tsx` — the one
numeral that ticks every second in place).

**G5 — resolved by `12f816e`.** The trips-list empty state is now centered
(`items-center`, `text-center`) and illustrated by the astronaut. Composed, illustrated,
actionable — the rule as stated now ships.

**G6 — resolved by `12f816e` (mascot) + `cb8ac6a` (error pages) + this branch (generation).**
The astronaut traveler (`docs/DESIGN-DRAFT.md:127-133` spec) ships as
`components/mascot/Astronaut.tsx`: line-art in the system's single 1.5px brass stroke
(non-scaling), the helmet quoting the constellation pin, the glove sketching a dotted star
path to a destination star. `currentColor` rides `--brass-bright`, so `.paper-scope` recolors
it automatically. It appears on exactly the four spec'd surfaces — trips-list empty state,
final onboarding step, error/404 pages (`ErrorScreen.tsx`, `not-found.tsx`), and the
generation rail — and nowhere else: never on the map canvas, never in the itinerary.
`variant="waiting"` (trail dots flowing toward the star) is the only animated state, live only
while generation is in flight, and registered in the reduced-motion block.

**G7 — resolved in two commits.** The eyebrow header was fixed by `c805e16` (section
headers serif sentence-case). The deeper half — remembered preferences rendering identically
to user-entered data, against §8's "disclosure is a feature" — resolved 2026-07-20: every
learned fact in the settings receipt now carries an `EvidenceChip` (`memory_preference` →
"Memory" for inferred facts, `requested_by_you` → "You" for stated ones), composed from the
§7 primitive rather than a new device (`SettingsView.tsx`, `lib/profile/memory.ts`).

---

## 13. Provenance

| Source | Role |
|---|---|
| `frontend/app/globals.css:16-48` | The implemented token system ("approved 2026-07-15") |
| `docs/DESIGN-DRAFT.md` | 2026-07-14 design session — reasoning, mascot spec. **Superseded by this file**, retained for its record |
| `docs/PRD.md` §3, §13, §15 | Brand and UX direction; map experience direction; generated trip content |
| `README.md:1-13` | Positioning line and the name |
| `9e85059` → `87bc3c7` | Phases 0–4 — the system as built |
| `52cf367` | The de-slop audit pass (score 14/20) whose corrections this document encodes |

Sections 1–11 describe shipped behavior verified against the working tree on 2026-07-20. Section
12 is the complete set of known divergences as of that date. When you change the system, change
this file in the same commit.
