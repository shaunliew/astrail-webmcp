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

> ### ⚠️ CORRECTION — 2026-07-20. Findings 1, 3 and 4 below were WRONG as first written.
>
> They were derived from screenshots plus the **`:root`** declaration of `.type-label`, without
> checking whether anything overrode it inside the app. Something does:
>
> ```css
> /* globals.css:362 — Rule 03: inside the app, UI labels are sans — mono is reserved for evidence. */
> .app-shell .type-label { font-family: var(--font-geist), …; font-weight: 600; }
> ```
>
> `app/app/layout.tsx:5` wraps the whole `/app` tree in `.app-shell`, so **every `.type-label` inside
> the product already renders Geist sans semibold, not uppercase mono.** Mono survives in exactly one
> class, `.type-evidence`, carrying the comment *"the only place monospace is allowed inside the
> app"* — i.e. the system already does precisely what finding 3 demanded it start doing.
>
> Worse, commit **`52cf367`** ("de-slop polish pass — impeccable audit P1/P2 findings, 14/20") had
> already run this exact audit and set the rule: *"uppercase tracked micro-labels are now reserved
> for form labels and data captions only."* Under that rule `TripBriefForm.tsx:15` is **correct
> usage**, not a violation. The original finding 3 would have "fixed" a screen into breaking its own
> audited standard.
>
> **Method error worth keeping:** a CSS class's identity is not its `:root` declaration — it is the
> cascade at the point of use. Grep the selector, not just the definition. The corrected findings
> follow; findings 2 and 5 survived verification unchanged.

1. ~~`TripBriefForm.tsx` — uniform uppercase-mono labels~~ **RETRACTED.** Labels render Geist sans
   semibold via the `.app-shell` override, and uppercase micro-labels on form fields are the
   standard set by the `52cf367` audit. No defect here.
2. **`frontend/components/settings/SettingsView.tsx`** (renders `07-settings.png`) — "Astrail
   learned:" (the mem0 personalization feature, the genuinely novel part of the product) and "Using
   your saved travel preferences" (static data) render as **two visually identical dark cards**. The
   differentiated feature gets no visual priority. **Confirmed still true** — `SettingsView.tsx` was
   never swept by `52cf367` (that diff touches InspirationTray, DaySelector, OrchestratorSummary,
   TradeoffPanel, TripWorkspace, TripCard — not Settings).
3. **The real violation, and it is a regression against the repo's own audited rule.**
   `SettingsView.tsx:55` styles an `<h2>` **section header** as an uppercase tracked micro-label —
   twelve lines above its sibling `<h2>` at `:67`, `"Astrail learned:"`, styled `type-display` serif
   sentence-case, the *corrected* post-audit treatment. Two structurally identical section headers,
   two design-system generations, one file. `TripBriefReview.tsx` (the comparable screen) is fully
   consistent, so this is a one-file miss from an unswept component — not a systemic pattern.
4. **⭐ HIGHEST LEVERAGE — the astronaut mascot is fully specified and was never built.**
   `docs/PRD.md` §3 builds the entire "astronaut traveler" persona around it; `DESIGN-DRAFT.md` §7
   specs exactly where it appears — *"waiting and empty moments — generation progress, empty states,
   final onboarding step, error pages."* `grep -rl astronaut frontend/` returns **zero hits.** Every
   screen the spec says should carry the product's one piece of character currently carries nothing.
   This is a far larger lever on "feels generic" than any label-casing nit, and it **subsumes the old
   finding 4**: the trips-list empty state *is* composed (dashed paper card, real copy "No trails
   yet. Your saved trips will land here.", working CTA) and fails only on *centered* and
   *illustrated* — illustrated being impossible while the mascot doesn't exist.
5. **`docs/DESIGN-DRAFT.md` was never promoted.** Prose only — no YAML front matter, not at repo
   root, not in DESIGN.md format, not wired into any installed skill. Its own header says "canonical
   UX doc is EMDEE `astrail/DESIGN.md`; merge this in after review with Shaun" — **verified
   2026-07-19: no such EMDEE doc exists** (EMDEE reachable, `search("astrail DESIGN")` → empty). So
   this draft IS the source of truth and can be transcribed directly.

## Recommended sequence

1. **Promote** `docs/DESIGN-DRAFT.md` → repo-root `DESIGN.md`, **grounded against shipped code, not
   copied.** The draft predates Phases 0–4 and the `52cf367` audit, so it carries claims the code has
   since overtaken — at minimum: (a) `.type-label` is sans inside `.app-shell`, mono now lives only
   in `.type-evidence`; (b) reel quotes are spec'd *"italic serif with a brass quote-bar"* but ship
   as `type-body` Geist sans at `PlaceIntelPanel.tsx:21`. Transcribe what is true, and mark each
   spec/ship gap as a gap rather than silently picking a side. Add two things the draft lacks: the
   **evidence-chip-as-primitive** contract (below) and the `SettingsView.tsx:55` before/after as the
   worked example of breaking vs following the rule.
2. **Run `/design-review`** against the live app *after* `DESIGN.md` exists — it now calibrates
   against Astrail's real constraints and treats deviations as higher severity, instead of guessing.
   It fixes what it finds via atomic commits with before/after screenshots.
3. **Land the two verified fixes** — `SettingsView.tsx:55`'s section header brought onto the audited
   rule, and a visual distinction between mem0-remembered and user-entered data in the same file.
   Both are inside one unswept component; neither is speculative.
4. **The mascot is a decision, not a task — do not build it autonomously.** It is the highest-leverage
   item and it is the one item an AI should not resolve unasked: it is net-new creative work in
   Zhi Hao's ownership area, it has no correctness criterion to verify against, and an invented
   mascot is the single change most likely to *produce* the "AI-generated" quality being complained
   about. Surface the gap, show that PRD §3 and DESIGN-DRAFT §7 already specify it, let Shaun and
   Zhi Hao decide.

## Second pass — the native shape, grounded in backend code

The method was verified against the live page (WebFetch fails — it's a Google Nemo SPA behind two
nested iframes; gstack `/browse` with two frame-switches got the real text). The prompt Shaun pasted
is **verbatim correct**. The page also offers a heavier path — `stitch-skills` as a Claude Code
plugin (`extract-design-md`, `code-to-design`). **Skip it**, now on correct grounds: its two relevant
capabilities are scanning for *scattered* undocumented tokens (Astrail's are already centralized in
one clean `globals.css` `:root` block) and uploading into a Stitch project for screen generation
(Astrail has a hand-built Next.js app). `voltagent/awesome-design-md` is a useful tone reference only.

**Astrail's native shape is codified in the backend, not a matter of taste:**

- `backend/models/place.py:21-49` — `PlaceResult.evidence_quote` is a **required** field. Every place
  in the system is structurally an evidence-carrying node.
- `backend/models/evidence.py:12-24` — `EvidenceKind` enumerates `reel_quote, requested_by_you,
  research, mapbox_route, open_meteo, travala_hotel_search, **memory_preference**, inferred_default,
  suggested_by_astrail`. **`memory_preference` sits in the same enum as `reel_quote`** — the backend
  already treats mem0 personalization as a *sibling kind of evidence*, not separate settings data.
- `docs/PRD.md` §3 mandates the shape in plain text: `scattered inspiration → verified places →
  connected route → saved trail`, and adds: **"Use this metaphor in interaction, not just decoration."**

So the shape is an **ordered, evidence-linked sequence**. The real question is which screens organize
around it and which impose a generic skeleton on top:

- **`06-trip-detail.png` already nails it** — numbered legs on the map, Day pills, `FROM REEL` tags
  with verbatim quotes, Upside/Tradeoff cards tied to specific route decisions. Its layout *is* the
  data's shape.
- **`TripBriefForm.tsx:15` does not.** One constant —
  `labelClass = 'type-label text-[11px] uppercase tracking-wide text-[var(--muted)]'` — applied
  uniformly to every field, Reel-paste box and origin-city input alike. No live preview of places
  accumulating as Reels are pasted. It is organized as a generic contact form, not as step one of the
  pipeline the PRD names.
- **`SettingsView.tsx`** renders "Astrail learned:" as a plain bulleted list, visually identical to
  static preference data — inventing a third visual language for something the backend already
  classifies as evidence. It should borrow the citation/chip treatment used for reel evidence.

## Sequencing is load-bearing: DESIGN.md FIRST, then `/design-review`

`/design-review` audits the rendered app against a craft checklist — *"is this page built well?"*
The DESIGN.md pass fixes the premise — *"is this the right page?"* `TripBriefForm.tsx` could pass
every craft check (correct contrast, consistent radius, focus rings — it probably already does) while
remaining premise-wrong. **A craft pass alone would just make the wrong page prettier.**

And per `design-review/SKILL.md:830-832`, once `DESIGN.md` exists it rates deviations from it *higher
severity* — so writing "screens organize around the ordered evidence-sequence, not a section
template" into its Layout/IA section makes the second pass flag `TripBriefForm.tsx` as a real finding
rather than a taste opinion.

**Path decision:** write **repo-root `DESIGN.md`** — that is where all four gstack skills look, and
what `DESIGN-DRAFT.md`'s own header calls canonical. Not `.stitch/DESIGN.md` (only relevant when
uploading to Stitch) and not `frontend/DESIGN.md` (outside the skills' search path).

**EMDEE question — RESOLVED 2026-07-19.** `DESIGN-DRAFT.md`'s header defers to an EMDEE
`astrail/DESIGN.md`. EMDEE is reachable (`search("astrail")` returns the roadmap cluster) and
`search("astrail DESIGN")` returns **empty**. No such doc exists. The local draft is the source of
truth and can be transcribed without risk of divergence.

## Not verified

- `docs/spec.md` (the full DESIGN.md spec) not fetched — the README + PHILOSOPHY.md agreed and were
  sufficient for the decision.
- `frontend/app/(app)/trips/…` source not opened; finding 4 is inferred from the screenshot plus the
  rule it violates. **Confirm the actual file before writing that fix.**
