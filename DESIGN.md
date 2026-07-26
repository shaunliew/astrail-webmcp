---
name: Astrail
tagline: Astrail turns scattered travel inspiration into the route you actually take.
status: canonical
supersedes: the deleted 2026-07-20 "Night & Daybreak" DESIGN.md
decided: 2026-07-26
implemented_in: design-mockup/css/{palette,type,skeleton}.css
---

# Astrail — Design

> This file records decisions. The CSS records values. Where they disagree, the CSS
> is right and this file is stale — fix it in the same commit.
>
> Restarted from scratch on 2026-07-26. The previous system ("Night & Daybreak") was
> deleted deliberately, not lost. Do not reinstate it from git history.

---

## 0. Where everything lives

| File | Owns |
|---|---|
| `design-mockup/css/palette.css` | Colour. Five roles, applied tokens, contrast-audited. |
| `design-mockup/css/type.css` | Typography. Three faces, role assignment. |
| `design-mockup/css/skeleton.css` | Layout, components, spacing, radius, responsive. |
| `design-mockup/js/sheet.js` | The retractable panel behaviour, shared by every map screen. |
| `design-mockup/00-palette.html` | Live colour spec with computed contrast ratios. |

Screens built: `01-dashboard`, `02-tray` (tray + plan sheet), `03-generating`,
`04-trip` (trip + place detail).

**`design-mockup/` is gitignored** (`.gitignore:28`). Nothing in it is recoverable
from git. Treat every file there as the only copy.

---

## 1. The one primitive

Astrail = Astra + Trail. A saved Reel is a point of light with no known position;
the product's whole job is to give it coordinates and connect it to the next one.

**One visual primitive, repeated everywhere: the point and the line.** It is the map
route, the loading state, the trip card thumbnail, the progress indicator, and the
empty state. Three states, mapping exactly to pipeline reality:

| State | Meaning | Rendering |
|---|---|---|
| **Unplaced** | Reel saved, not yet resolved | dim dashed dot, no label |
| **Verified** | lat/lng + evidence confirmed | brass pin, snapped, labelled |
| **Connected** | Mapbox leg computed | brass line drawn to the next stop |

### No decorative star exists

Every point of light on screen is a real place, or a Reel waiting to become one.
No starfields, no faceted nebulas, no low-poly space. This is not an aesthetic
preference — it is what makes the constellation mean anything. Atmosphere is
allowed (gradients, vignette, glow) because that is *lighting*. Objects are not.

Considered and rejected 2026-07-26: origami / paper-fold texture. The fold metaphor
is sound (a folded paper map is the travel object) but it is decoration, and
faceted-geometric reads as a 2010s aesthetic.

---

## 2. Colour

Full values in `palette.css`. Five roles:

| Role | | Values |
|---|---|---|
| 1 · Main | **Brass** | `#E8B667` bright · `#C9974E` mid · `#8A5A18` deep |
| 2 · 2nd main | **Night** | `#0A0D14` · `#12161F` · `#1B2130` |
| 3 · Highlighter | **Spruce** | `#0E4239` deep · `#6FC9B4` bright |
| 4 · Base | **Paper** | `#FCFAF3` · `#F5F1E6` · `#EDE7D8` |
| 5 · Base | **Ink** | `#1C1710` · `#635945` · `#93876C` |

### Brass means verified

Brass is the only brand hue and it carries one meaning: **confirmed by evidence.**
It appears bright against the map and deep inside paper panels — one hue in two
lighting conditions, which is how gold behaves. Never use it decoratively, never on
borders or body text, never to highlight an arbitrary word in a sentence.

### The map is the only dark surface, and it never changes

The UI palette is fixed. Night→dawn still happens, but in the basemap's Mapbox
`lightPreset`, driven by product state — because the map is content, not chrome.
Two UI themes were built and rejected: users get nothing from chrome shifting under
them mid-flow, and it doubles the QA surface.

### Warn has no hue

This is the least obvious rule and the easiest to break. **Amber is the brand
colour, so an amber warning would collide with the accent and stop meaning
"verified."** Warnings use `ink-600` plus a dashed border. A missing route leg or an
unavailable forecast is a fact about the world, not an error the user caused, and it
should not look like one.

### Two measured findings that changed the palette

Both are in the audit table on `00-palette.html`, computed not estimated.

- **`brass` mid is 2.32:1 on paper.** It is not a text colour. Fills, trail core and
  large marks only. Its failure in the audit is the guardrail — do not "fix" it.
- **Spruce and brass at equal lightness sat 1.03:1 apart** — identical in greyscale.
  Spruce was darkened to `#0E4239` for 1.92:1 separation. A contrast colour that
  only contrasts in hue is not one.

### On dark, hue cannot carry meaning

`brass-bright` and `spruce-bright` sit **1.06:1** apart in luminance. On a dark
ground everything legible must be light, so the two read as "two light things", not
two meanings. Semantics on night surfaces must be carried by label or shape.

---

## 3. Typography

Full assignment in `type.css`.

| Role | Face | Notes |
|---|---|---|
| Display | **Fraunces** | variable; `SOFT 28`, `WONK 1`, `opsz` tracks rendered size |
| UI | **Figtree** | 400 / 500 / 600 |
| Evidence | **IBM Plex Mono** | provenance only |

**Inter is banned.** It is simultaneously the dominant UI font and the most
recognisable AI-slop tell. With a palette this restrained, type carries the brand.

### Mono means provenance

Monospace on screen has exactly one meaning: **this is verbatim data from a source,
or a value a source returned.** Source names, counts of real rows, Mapbox durations,
Travala prices, timestamps.

It is **not** for Astrail's own words. `place_type` rendered as "Attraction" and
`analysis_status` rendered as "Processing" are Astrail's labels for a state — they
are UI, and they were wrongly set to mono in the first draft. The exclusions are
named in `type.css` so they do not come back.

### The quote is italic display, never italic UI

A slanted interface font is still the interface talking. Only a change of face is a
change of voice. A verbatim Reel quote is italic Fraunces over a brass bar.

### `opsz` tracks size; `WONK` drops out of lists

Fraunces thins strokes and tightens spacing as `opsz` rises — set it to the rendered
px size or the family stops looking like one family. `WONK` goes to 0 on stop names,
trip cards and hotel names: a leaning letter is charming once per screen and noisy
six times.

### Uppercase tracked labels are reserved

Form labels and data captions only. Section headers are display, sentence case.
Never an uppercase eyebrow above a heading.

---

## 4. Layout — the map is the canvas

Everything floats over one persistent map. There are no pages inside the app; there
are sheets and pills. Opening a collection flies the map to its contents.

- **Desktop**: the reading surface is a 420px rail, inset left over a full-bleed map.
- **Mobile**: a bottom sheet at 55dvh, map above.
- **Retractable, always** (`js/sheet.js`). Click or drag the grip. Desktop collapses
  the rail to a **52px vertical strip** pinned left; mobile collapses to a 60px peek
  bar carrying the screen's title. The collapsed state is the control — there is no
  separate floating button to hunt for.
- The map **re-insets** when the rail retracts, so the reclaimed width is actually
  used.

### Geometry

Spacing on a strict 4px scale (4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96). Radius:
6 chips, 8 cards, 16 panels, 999 pills — nothing else. Depth comes from shadow on
paper, from borders and glow on night.

### One coordinate box for map layers

Pins and the trail live inside a single `.mapzone` div that owns the geometry.
**Do not put insets on the SVG directly**: `viewBox="0 0 100 100"` gives it a 1:1
intrinsic ratio which overrides `bottom`, so the trail renders square and drifts off
the pins. This was a real bug; it is invisible until you measure
`getBoundingClientRect()`.

---

## 5. Motion

**Only live states animate.** A pulse on a finished trip is motion telling a lie.
The breathing dot stops the moment "Saved" lands.

**Beats fire on events, not timers.** On the generating screen the camera moves
exactly once, when the destination resolves:

```
globe                    → nothing located yet, so nothing is drawn
destination resolved     → BEAT 1: globe flies out, city map fades up
place verified           → a pin lands
leg computed             → the trail draws
SSE `result`             → basemap relights night → dawn
```

The globe is not a loading screen. Generation takes 60–180s and hiding progress
behind an animation would delete "time to first mapped value", which is the only
thing proving the agent is doing more than a competitor. Entrance curve:
`cubic-bezier(0.16, 1, 0.3, 1)`. Register every new animation in the
`prefers-reduced-motion` block.

---

## 6. The evidence chip

Astrail's differentiator is that no place appears without its receipt. **A claim and
its evidence render together, never separately.** There is no "details" view where
provenance lives instead.

Three epistemic tiers, **distinguished structurally before colour**, so they survive
greyscale, print and colour-blindness:

| Tier | Structure | Means |
|---|---|---|
| Evidence | solid border + filled mark | proven, verbatim — `Reel`, `You`, `Research` |
| Tool | plain border, no mark | a tool said so — `Mapbox`, `Travala`, `Weather` |
| Inferred | dashed border | Astrail's own guess — `Astrail`, `Memory`, `Default` |

Colour only reinforces. Given the 1.06:1 finding in §2, structure is not optional.

**"Mentioned in" beats a single quote.** `reel_place_mentions` holds every Reel that
names a place; the place panel shows them all. One quote in a chip is a claim; five
receipts is a proof.

---

## 7. Voice

- **Raw enums never render.** `saved_with_gaps` → "Saved with gaps".
- **Decisions, not logs.** "Dropped 2 places — no coordinates found", not a stage
  trace. No model thinking ever surfaces.
- **Failure is inline, recoverable, and never a filter.** A browsable "Failed"
  category tells the user failure is routine. A failed trip keeps its place in the
  list, states what survived ("2 places saved"), gives the reason from
  `jobs.error_message`, and offers Retry. The badge says "Couldn't finish" — the
  trip didn't fail, a step did.
- **Ship visibly imperfect data rather than hiding the item.** A bad geocode shown
  is honest; a silently dropped place is not.
- **Every ask states its payoff on the same screen**, and every disabled button says
  what it is waiting for.

---

## 8. Do / Don't

**Do**

- Concentrate brass: trail, active state, primary action, verified evidence. That's the budget.
- Reserve mono for provenance.
- Use display sentence-case for section headers.
- Stay on 4px spacing and 6/8/16/pill radius.
- Keep the map mounted and let panels retract off it.
- Render evidence with the claim.
- Measure contrast before shipping a new pair.

**Don't**

- Don't animate anything that isn't live.
- Don't use amber for warnings — it is the brand colour.
- Don't use `brass` mid (`#C9974E`) for text.
- Don't rely on hue alone for meaning on dark surfaces.
- Don't put mono on Astrail's own words.
- Don't add a decorative star, particle, or nebula.
- Don't introduce Inter.
- Don't inset a `viewBox` SVG directly — wrap it in `.mapzone`.

---

## 9. Open

- **The shipped frontend disagrees with this document.**
  `frontend/app/globals.css` still carries the old Night & Daybreak tokens, and
  `frontend/app/layout.tsx:7-20` still loads Instrument Serif / Geist / JetBrains
  Mono. Nothing here has been ported yet. Port or revise deliberately; don't let
  them drift silently.
- **`frontend/reference/current/*.png` are stale** and predate several fixes. Do not
  review against them.
- Screens not yet designed: sign-in, onboarding (2 steps + Skip, see
  `design-mockup/YAAY-ONBOARDING-TEARDOWN.md` §6), share-receive sheet, settings.
- Mobile trip detail is cramped — six stops with quotes and chips in a 55dvh sheet.
  A collapsed one-line-per-stop mode is unresolved.
- No weather anywhere. PRD §15 wants a per-day note; the day header needs a slot
  that can be empty without looking broken.
- Tile multi-select in the tray is undesigned, so "Plan a trip from these" currently
  implies all of them.
- Beta cut decisions (collections, sections, reactions deferred) are recorded in
  `design-mockup/YAAY-CORE-TEARDOWN.md` §0.

---

## 10. Provenance

| Source | Role |
|---|---|
| `design-mockup/css/*` | The implemented system — authoritative over this file |
| `design-mockup/YAAY-*.md` | Competitor teardowns; the beta scope cut lives in CORE §0 |
| `docs/PRD.md` §3, §13, §15, §16 | Brand, map lighting, trip content, latency targets |
| Deleted `DESIGN.md` (2026-07-20) | Prior system, retired on purpose |
