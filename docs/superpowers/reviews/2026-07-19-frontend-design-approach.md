# Frontend "looks AI-generated" — diagnosis and approach

> Research pass 2026-07-19, prompted by Zhi Hao's feedback that the frontend "still gives AI feeling
> although I use all the skills alr". Evaluates `design.md` (google-labs-code) against the installed
> gstack design tooling, and grounds the diagnosis in the actual code + the 7 reference screenshots.
>
> **Headline: the premise was wrong.** Astrail's design system is genuinely intentional and exhibits
> **none** of the structural AI-slop patterns. The problem is narrower and more fixable than "redo
> the frontend".

## design.md and gstack are the same convention, not competing options

`google-labs-code/design.md` (Apache-2.0) is a **file-format spec + optional CLI**, not a generator.
You author `DESIGN.md`: YAML front matter (colors, typography, spacing — as *context*, not enforced
values) plus prose sections in a fixed order. Its philosophy, quoted from `PHILOSOPHY.md`:

> "The quality of a generated design is determined less by the precision of its values than by how
> clearly the intent is described." · "A specific reference carries more than a list of adjectives."

**The load-bearing finding:** the four installed gstack design skills already read a repo-root
`DESIGN.md` and calibrate against it —

| Skill | Behaviour |
|---|---|
| `design-review` | "If found, read it — all design decisions must be calibrated against it. **Deviations are higher severity.** If not found, use universal design principles" |
| `design-consultation` | Its entire job is "Creates DESIGN.md as your project's design source" |
| `design-html` | Reads `DESIGN.md` tokens; "these override any extracted values" |
| `design-shotgun` | "DESIGN.md is the default constraint" |

So this was never a choice between them. **Astrail simply has no `DESIGN.md`**, which is why
`/design-review` re-derives generic rules every run instead of enforcing Astrail's own.

**Do NOT install `@google/design.md`.** Authoring the file needs zero dependencies. The CLI's only
relevant features — WCAG contrast lint, structural lint — are already covered by `design-review`'s
Color & Contrast checklist, which is arguably better because it checks *rendered pixels* rather than
declared tokens. Its `export --format css-tailwind` is moot: Astrail hand-maintains Tailwind v4
custom properties in `globals.css`, a better source of truth than a round-tripped `@theme` block. A
new npm dependency for a linter this narrow is what `STACK.md` exists to prevent.

## The system is already good — this is the surprising part

From `frontend/app/globals.css` (608 lines) and `docs/DESIGN-DRAFT.md` (2026-07-14, "Night &
Daybreak"):

- **Three fonts, each with one strict role** — Instrument Serif display-only, Geist for UI,
  JetBrains Mono reserved for evidence/provenance. The CSS comment states it outright: *"Mono =
  provenance. The only place monospace is allowed inside the app."*
- **Two-value radius scale** (8px card / 6px chip) — not one bubbly radius everywhere
- **A single accent** (brass) with a stated concentration rule
- **Dual night/paper worlds** with real dark-mode elevation, not lightness inversion
- Semantic colours paired per world; reduced-motion handled; a signature route/constellation motif
  reused across landing → map → itinerary

Against `design-review`'s own 10-pattern AI-slop blacklist (purple gradient bg, 3-col icon-circle
grid, centered-everything, uniform bubbly radius, decorative blobs, emoji-as-design, colored-left-
border cards, generic hero copy, cookie-cutter section rhythm, system-ui as primary) — **none are
structurally present.** The landing (`01`) and trip detail (`06`) are the strongest counter-evidence:
left-aligned asymmetric hero, real founder photo + hackathon badge rather than stock imagery,
evidence-driven "Price vs rating" cards with Upside/Tradeoff prose instead of generic feature cards,
numbered itinerary with verbatim reel-quote provenance.

## Where it actually reads generic — 5 concrete findings

1. **`frontend/components/create/TripBriefForm.tsx`** (renders `04-create-trip.png`) — the weakest
   screen and the first real interaction after the landing page. Every field gets identical
   treatment: uppercase-mono label → dark input, stacked vertically, **no visual anchor**. A
   workmanlike SaaS form on the highest-stakes screen.
2. **`frontend/components/settings/SettingsView.tsx`** (renders `07-settings.png`) — "Astrail
   learned:" (the mem0 personalization feature, the genuinely novel part of the product) and "Using
   your saved travel preferences" (static data) render as **two visually identical dark cards**. The
   differentiated feature gets no visual priority.
3. **⭐ HIGHEST LEVERAGE — `.type-label` is overused.** Both screens above apply the uppercase
   JetBrains Mono treatment — defined in the system as *provenance only* — as the default for every
   plain form label. Applying one typographic device uniformly regardless of importance is
   **structurally the same failure as uniform border-radius**, just typographic instead of geometric.
   Fix: reserve mono-caps for actual evidence (reel quotes, coordinates, confidence %, source chips —
   exactly what `DESIGN-DRAFT.md` §3 already specifies) and give plain UI labels a quieter
   sentence-case Geist treatment. This one change should de-genericize both weak screens.
4. **Trips list** (`05-trips-list.png`) — one card floating in a large empty cream field.
   `DESIGN-DRAFT.md` §4 already states the violated rule: *"Empty screens are composed (centered,
   illustrated, actionable), never content-top-left-plus-void."* The system wrote the rule; the
   screen doesn't follow it.
5. **`docs/DESIGN-DRAFT.md` was never promoted.** Prose only — no YAML front matter, not at repo
   root, not in DESIGN.md format, not wired into any installed skill. Its own header says "canonical
   UX doc is EMDEE `astrail/DESIGN.md`; merge this in after review with Shaun" — **verified
   2026-07-19: no such EMDEE doc exists** (EMDEE reachable, `search("astrail DESIGN")` → empty). So
   this draft IS the source of truth and can be transcribed directly.

## Recommended sequence

1. **Transcribe** `docs/DESIGN-DRAFT.md` + the `:root` tokens from `globals.css` into a repo-root
   `DESIGN.md` in the real spec format (YAML front matter + ordered prose sections + a Do's/Don'ts
   list built from the rules already written: "brass concentration", "mono = provenance only",
   "radius is 8/6 only", "empty screens are composed"). This is **transcription of an approved
   system, not new design work**.
2. **Run `/design-review`** against the live app *after* `DESIGN.md` exists — it now calibrates
   against Astrail's real constraints and treats deviations as higher severity, instead of guessing.
   It fixes what it finds via atomic commits with before/after screenshots.
3. **Land the three named fixes** — label hierarchy in `TripBriefForm.tsx` and `SettingsView.tsx`,
   and a composed empty state for the trips list.

## Not verified

- `docs/spec.md` (the full DESIGN.md spec) not fetched — the README + PHILOSOPHY.md agreed and were
  sufficient for the decision.
- `frontend/app/(app)/trips/…` source not opened; finding 4 is inferred from the screenshot plus the
  rule it violates. **Confirm the actual file before writing that fix.**
