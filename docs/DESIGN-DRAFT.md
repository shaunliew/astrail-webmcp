# Astrail Design System — "Night & Daybreak" (DRAFT)

> Proposal drafted 2026-07-14 (Claude + Zhi Hao design session). Not yet canonical —
> canonical UX doc is EMDEE `astrail/DESIGN.md`; merge this in after review with Shaun.
> Grounded in `docs/PRD.md` §3 (brand), §13 (map lighting), §15 (evidence UI).

## 1. The story drives the system

Astrail = Astra + Trail. The user's journey has two acts, and the PRD already assigns
each act a lighting state (§13: "dusk/night lighting during inspiration and generation,
readable trip exploration lighting after generation"):

| Act | What the user is doing | World |
|---|---|---|
| **Night** | Dreaming: sign-in, onboarding, pasting Reels, trip brief, generation/launch | Dark indigo sky, starlight text, brass constellations |
| **Daybreak** | Holding the plan: trip workspace, itinerary, trips list, settings | Warm paper surfaces, ink text, dawn-lit map |

The transition between them is the product's signature moment: **generation completes →
the map relights from night to dawn and the paper itinerary arrives.** Scattered
inspiration (night) becomes the route you actually take (day). Plan by night, travel
by dawn.

One thread runs through both worlds: **brass** — the star-gold of the trail. It is the
only brand accent, and it appears bright on night, deep on paper.

## 2. Color schema

### Night world (Astra)

Never neutral black — neutral dark grey reads dirty. Night is indigo-shifted.

| Token | Value | Use |
|---|---|---|
| `--night-void` | `#0A0B14` | Page ground, map frame |
| `--night-deep` | `#111322` | Recessed areas, inputs |
| `--night-surface` | `#191C2E` | Cards, panels (always with `--shadow-night`) |
| `--night-line` | `rgba(200, 205, 255, 0.10)` | Hairlines (cool-tinted) |
| `--starlight` | `#F7F3E8` | Primary text |
| `--starlight-muted` | `rgba(247, 243, 232, 0.72)` | Secondary text |
| `--starlight-faint` | `rgba(247, 243, 232, 0.45)` | Tertiary/labels |
| `--nebula-indigo` | `rgba(42, 49, 96, *)` | Background atmosphere only |
| `--nebula-teal` | `rgba(52, 210, 214, 0.04–0.08)` | Background atmosphere only (already in landing) |
| `--shadow-night` | `inset 0 1px 0 rgba(247,243,232,0.07), 0 1px 2px #000c, 0 8px 28px #0009` | Card light source |

### Daybreak world (Trail)

| Token | Value | Use |
|---|---|---|
| `--paper-0` | `#FBF8F1` | Cards (gradient to `#F5EFE3`) |
| `--paper-1` | `#F3EEE2` | Page ground (trips list, settings) |
| `--paper-line` | `rgba(26, 24, 16, 0.08)` | Hairlines |
| `--ink` | `#1A1810` | Primary text |
| `--ink-muted` | `rgba(26, 24, 16, 0.64)` | Secondary text |
| `--ink-faint` | `rgba(26, 24, 16, 0.42)` | Tertiary/labels |
| `--shadow-paper` | `0 1px 2px rgba(26,24,16,0.10), 0 8px 24px rgba(26,24,16,0.10)` | Card float (over map: deepen to `#000` alphas) |

### The brass thread (only brand accent)

| Token | Value | Use |
|---|---|---|
| `--brass-bright` | `#EFC98D` | Text/glow on night surfaces (small-text safe) |
| `--brass` | `#C9974E` | Trail core, fills, large marks |
| `--brass-deep` | `#8A6023` | Text on paper surfaces (AA at small sizes) |
| `--brass-glow` | `rgba(201, 151, 78, 0.16–0.45)` | Halos, pulses, active-state washes |

Brass concentration rule: per screen, brass belongs to at most — the route trail, the
active state, the primary action, and status pulses. Never on borders, labels, or body
text.

### Semantic (separate from accent, never color-only)

| Token | Night | Paper | Meaning |
|---|---|---|---|
| `--ok` | `#7BC9A6` | `#2E7D5B` | Verified place, route ok, trip complete |
| `--warn` | `#D9A441` | `#9A731F` | Long transfer, saved with gaps, skipped stage |
| `--fail` | `#D0705F` | `#A8453A` | Failed reel, no route, generation failed |

Semantic color always ships with an icon or label — chips, not bare dots.

## 3. Typography

| Role | Face | Rules |
|---|---|---|
| Display | Instrument Serif | Trip titles, day headings, stat numerals. -0.01em. Never below 18px. |
| UI | Geist | Body 15 / secondary 13 / label 11 (600, +0.08em, uppercase). All controls. |
| Evidence | JetBrains Mono | **Provenance only**: reel quotes metadata, confidence %, coordinates, source chips. 10–11px. Mono appearing = "this is verbatim data." |

`font-variant-numeric: tabular-nums` on all stats, durations, distances. Reel quotes
render in italic serif with a brass quote-bar — the voice of the source, not the UI.

## 4. Surfaces, radius, space

- Radius: `8px` cards · `6px` chips · `999px` pills. Nothing else.
- Borders at 7–10% alpha + shadow stacks; depth comes from light, not lines ("borders
  you feel, not see").
- "The lights are on": every dark screen has a light source — inset top highlight on
  cards + one ambient brass/nebula glow. Dark ≠ dim; night sky, never basement.
- 4/8pt spacing grid. Empty screens are composed (centered, illustrated, actionable),
  never content-top-left-plus-void.

## 5. Map treatment (the core surface)

- Style: Mapbox Standard, `lightPreset` driven by product state:
  `night` during inspiration/generation → animate to `dawn` when the trip is ready
  (PRD §13's two lighting states, made literal).
- Basemap POI density dimmed via style config — Astrail pins must win the canvas.
- **Constellation pins**: numbered nodes (ink disc, brass ring, brass-bright numeral)
  with `--brass-glow` halo; selected pin pulses once. Source type varies the ring:
  reel = solid, requested = double, suggested = dashed.
- **The trail**: brass gradient stroke with soft glow casing; dash-flow animation on
  the active day only. On dawn map: brass core with warm-white casing for contrast.
- Failed/missing legs: dashed `--fail` stub + honest label chip (PRD §14).

## 6. Signature moments (motion)

Micro-motion: 200–300ms ease-out; panels 380ms; springs, no bounces.
`prefers-reduced-motion`: all decorative motion off, states swap instantly.

1. **Pins land** during generation — scale-in with a single halo ripple as each place
   verifies (the "time to first mapped value" beat, PRD §16).
2. **Trail draws** — dash-offset reveal connecting the day's stops in order.
3. **Daybreak** — on `result`: 2s map relight night → dawn, paper panels slide up.
   This is the reward moment; protect it.
4. **Launch** — on generate: camera pulls up and away toward destination. Restrained;
   if it delays first pin, cut it (PRD §3: metaphor must never slow the workflow).

## 7. The astronaut (mascot rules)

Small line-art astronaut, single-weight brass stroke, 24–48px. A quiet guide, not a
brand clown: appears only in waiting and empty moments — generation progress, empty
states, final onboarding step, error pages. Never on the map canvas, never in the
itinerary, no looping attention-seeking animation. Apple-clean product, one warm
companion.

## 8. Voice

- Statuses are English: `saved_with_gaps` → "Saved with gaps". Raw enums never render.
- Timeline speaks in decisions: "Dropped 2 places without coordinates." (PRD §15)
- Disclosure is a feature: preference source, inferred assumptions, and gaps are
  stated plainly — trust comes from showing the work, in words a traveler uses.

## 9. Accessibility gates

- Ink on paper ≈ 14:1 · starlight on void ≈ 15:1 · `--brass-deep` on paper ≥ 4.5:1 ·
  `--brass-bright` on night ≥ 7:1. `--brass` (#C9974E) is **not** a small-text color.
- Focus: 2px `--brass` outline, 2px offset, both worlds.
- Semantic states never color-only; map information also exists in the itinerary list.

## 10. Anti-patterns (hard no)

Pure black grounds · neutral-grey darks · brass sprinkled on borders/labels · mono for
UI labels · raw enum strings · cartoon planets/rockets (PRD §3) · decorative effects
that reduce map readability (PRD §13) · murk (same-value surface-on-ground) · native
date/select controls in shipped UI.
