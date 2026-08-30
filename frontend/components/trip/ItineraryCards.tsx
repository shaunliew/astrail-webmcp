'use client'

import { useEffect, useRef } from 'react'
import type {
  TripPlace, PlaceSourceType, TransportLeg, Place, TripBundle,
} from '@/lib/trip/backend-types'
import { thumbnailFor } from '@/components/map/popup-model'
import EvidenceChip from './EvidenceChip'
import { fmtDuration } from './TransportStrip'

const SOURCE_BADGE: Record<PlaceSourceType, string> = {
  reel_extracted: 'From reel',
  user_requested: 'You asked',
  agent_suggested: 'Astrail pick',
}

/* A quote earns its space only when it says something the heading did not.
   Real captions very often yield an evidence quote that IS the place name —
   "📍Tokyo Dream Park" against a stop called Tokyo Dream Park — and rendering it
   prints the same words twice, the second time in a decorative face. The evidence
   chip still carries the provenance, so nothing is hidden by dropping the echo. */
function addsNothing(quote: string, name: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase()
      .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')   // strips 📍, quotes, dashes, punctuation
      .trim()
  const q = norm(quote)
  const n = norm(name)
  return q.length === 0 || q === n || n.includes(q)
}

type RouteLink = {
  leg: TransportLeg
  /* Where you are setting off from, but ONLY when the reader cannot already see it. Between two
     stops on this list the origin is the card directly above, and repeating it is noise. */
  from: string | null
}

/* One rule — "the leg that BRINGS you to this stop" — and it covers both shapes the data takes:
   the hop between two stops on this day, and the arrival into the day's first stop from
   yesterday's last one. The second case is not hypothetical: in the demo trip, day 3's only leg
   starts on day 2, so a fold that matched consecutive pairs alone would silently drop that day's
   routing warning. Anything still unclaimed (a leg leaving the last stop, an unresolved endpoint)
   trails the list rather than vanishing — this fold is the only place the legs are shown. */
function buildRouteLinks(
  places: TripPlace[], legs: TransportLeg[], placeIndex?: Map<string, Place>,
): { above: (RouteLink | null)[]; trailing: RouteLink[] } {
  const claimed = new Set<string>()
  const nameOf = (id: string | null) => (id ? placeIndex?.get(id)?.name ?? null : null)
  const above = places.map((tp, i) => {
    const leg = legs.find((l) => l.to_place_id === tp.place_id && !claimed.has(l.id))
    if (!leg) return null
    claimed.add(leg.id)
    const fromVisibleAbove = i > 0 && leg.from_place_id === places[i - 1].place_id
    return { leg, from: fromVisibleAbove ? null : nameOf(leg.from_place_id) }
  })
  const trailing = legs
    .filter((l) => !claimed.has(l.id))
    .map((leg) => ({ leg, from: nameOf(leg.from_place_id) }))
  return { above, trailing }
}

// ── Estimated times ─────────────────────────────────────────────────────────────────────────
//
// Read this before adding a fallback to any of it.
//
// Astrail holds NO clock time and NO dwell duration. `TripPlace` has no duration field, `TripDay`
// has none, and the only `place_durations` in the schema hangs off `HotelSuggestion`, where it is
// the hotel-hub → place ROUTE duration (see selectors.ts::hubSpokeFeatures) — a travel time, not
// time spent at a place. Reading it as dwell would print "3 hrs here" against Disneyland from a
// number that actually measures the trip out from Shinjuku: a claim the page cannot support, on
// the one surface whose entire argument is that every claim is evidence-backed (guardrail #1).
//
// So a schedule can only ever be DERIVED, from durations we really hold, and only as far as they
// reach. The chain stops the moment the next number is unknown — a stop with no dwell keeps its
// arrival and loses its departure; an unrouted or missing leg ends the estimates for that day
// entirely. Even spacing to "fill the column" is the failure mode this shape exists to prevent.
//
// `dwellSeconds` therefore has no default and no fallback: no source is wired today, so nothing
// renders today. That is the honest output, not a gap to be papered over.

/** The one assumption on this surface, and it is stated in the UI rather than buried here. */
const DAY_START_MINUTES = 9 * 60      // 09:00 local

type StopEstimate = { start: number; end: number | null }

/** Whole minutes, matching what `fmtDuration` prints for the same leg, so the folded leg saying
    "3 min" and the clock advancing by 3 can never disagree. Null = we do not know. */
function knownTravelMinutes(link: RouteLink | null): number | null {
  if (!link || link.leg.status !== 'ok') return null
  const s = link.leg.duration_seconds
  return s !== null && Number.isFinite(s) ? Math.round(s / 60) : null
}

function deriveEstimatedTimes(
  places: TripPlace[],
  above: (RouteLink | null)[],
  dwellSeconds: Map<string, number> | undefined,
  dayStartMinutes: number = DAY_START_MINUTES,
): (StopEstimate | null)[] {
  const none = places.map(() => null)
  // No dwell anywhere on the day means the 9:00 start is the ONLY number we would be printing —
  // an assumption with no data under it. An empty map is no data, not a day that starts at 9.
  const anyDwell = dwellSeconds !== undefined
    && places.some((p) => Number.isFinite(dwellSeconds.get(p.place_id)))
  if (!dwellSeconds || !anyDwell) return none

  const out: (StopEstimate | null)[] = []
  let cursor = dayStartMinutes
  let known = true
  for (let i = 0; i < places.length; i++) {
    if (i > 0) {
      const travel = knownTravelMinutes(above[i] ?? null)
      if (travel === null) known = false
      else cursor += travel
    }
    // Past midnight the wall clock would silently read as the same day. Stop instead.
    if (!known || cursor >= 24 * 60) { out.push(null); known = false; continue }
    const start = cursor
    const dwell = dwellSeconds.get(places[i].place_id)
    if (dwell === undefined || !Number.isFinite(dwell)) {
      out.push({ start, end: null })   // we know when you arrive, not when you leave
      known = false
      continue
    }
    cursor = start + Math.round(dwell / 60)
    out.push({ start, end: cursor })
  }
  return out.some((e) => e !== null) ? out : none
}

/** 24-hour and zero-padded, so a right-aligned column of them stays one column. */
function fmtClock(minutes: number): string {
  const m = Math.round(minutes)
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

// ── Timeline scaffolding ────────────────────────────────────────────────────────────────────

const RAIL_LINE = 'w-0 border-l border-dashed border-[var(--line)]'

/* The rail. It is what turns a stack of cards into one continuous route: a line running through
   every step marker, carrying the hop between them. Dashed rather than solid on purpose — it
   reads as a path rather than as a rule someone forgot to join up. The marker column is the SAME
   width and offset on a leg row as on a stop row, which is what keeps the line unbroken past the
   card edges. */
function RailCell({ dot, capTop, capBottom }: {
  dot?: React.ReactNode
  capTop?: boolean
  capBottom?: boolean
}) {
  return (
    <span aria-hidden className="flex w-6 shrink-0 flex-col items-center self-stretch">
      <span className={[dot ? 'h-3.5' : 'flex-1', capTop ? '' : RAIL_LINE].join(' ')} />
      {dot ?? null}
      <span className={['flex-1', capBottom ? '' : RAIL_LINE].join(' ')} />
    </span>
  )
}

/** The left column. Empty (and zero-width) on every row unless the day has estimates at all —
    an "Est." heading over a column of blanks is worse than no column. */
function TimeCell({ estimate, show }: { estimate?: StopEstimate | null; show: boolean }) {
  if (!show) return null
  return (
    <span className="flex w-12 shrink-0 flex-col items-end pt-2.5 text-right">
      {estimate ? (
        <>
          <span className="type-label text-[9px] uppercase tracking-wide text-[var(--faint)]">Est.</span>
          <span className="type-label text-[13px] tabular-nums leading-tight text-[var(--starlight)]">
            {fmtClock(estimate.start)}
          </span>
          {estimate.end != null ? (
            <span className="type-label text-[11px] tabular-nums leading-tight text-[var(--muted)]">
              {fmtClock(estimate.end)}
            </span>
          ) : null}
        </>
      ) : null}
    </span>
  )
}

/** A stop's cover, or the honest absence of one. `thumbnailFor` returns null for every stop that
    did not come from a Reel — an Astrail pick or a place the traveller asked for — and inventing
    an image there would attach a Reel to a stop no Reel produced. The dashed empty tile says
    "nothing was pulled from a Reel here"; the source badge and evidence chip beside it say what
    WAS behind the stop. */
function Cover({ url }: { url: string | null }) {
  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url} alt="" loading="lazy"
        className="h-14 w-14 shrink-0 rounded-[10px] border border-[var(--line)] object-cover"
      />
    )
  }
  return (
    <span
      aria-hidden data-cover="none"
      className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[10px] border border-dashed border-[var(--line)]"
    >
      <svg
        viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5 text-[var(--faint)]"
      >
        <path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z" />
        <circle cx="12" cy="10" r="2.5" />
      </svg>
    </span>
  )
}

function RouteLinkRow({ link, showTimes }: { link: RouteLink; showTimes: boolean }) {
  const { leg, from } = link
  const routed = leg.status === 'ok'
  const timing = [
    fmtDuration(leg.duration_seconds),
    leg.distance_meters != null ? `${(leg.distance_meters / 1000).toFixed(1)} km` : '',
  ].filter(Boolean).join(' · ')
  return (
    <div className="flex items-stretch gap-2 px-3">
      <TimeCell show={showTimes} />
      <RailCell />
      <p className="type-label min-w-0 flex-1 py-1.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
        {/* A place name is a name — it keeps its own case even inside a label-cased line. */}
        {from ? (
          <span className="normal-case tracking-normal text-[var(--faint)]">from {from} · </span>
        ) : null}
        {leg.transport_mode.replace('_', ' ')}
        {routed && timing ? (
          <span className="tabular-nums text-[var(--brass-bright)]"> · {timing}</span>
        ) : null}
        {/* An unrouted leg keeps its warning here. Folding the legs in only stays honest if the
            fold carries everything the separate strip carried. */}
        {!routed ? (
          <span className="type-body block normal-case tracking-normal text-[11px] text-[var(--muted)]">
            No route. {leg.warning ?? 'Routing unavailable for this leg.'}
          </span>
        ) : null}
      </p>
    </div>
  )
}

/** A bare stretch of rail between two stops the data gives no leg for. Most saved trips have no
    legs at all, and the eye still has to be carried from one step to the next. */
function RailGap({ showTimes }: { showTimes: boolean }) {
  return (
    <div className="flex items-stretch gap-2 px-3">
      <TimeCell show={showTimes} />
      <RailCell />
      <span className="block h-3 flex-1" />
    </div>
  )
}

export default function ItineraryCards({
  places, trailNumbers, selectedPlaceId, onSelectPlace, legs = [], placeIndex, bundle,
  dwellSeconds,
}: {
  places: TripPlace[]
  /* `buildTrailNumbers` — the SAME map the pins are painted from and `resolvePlaceRef` answers
     to. Required, and with no per-day fallback, on purpose: the day's stops cannot tell you
     their trail number, and a panel that counts 01, 02 per day while the map and the tools
     count 1..N across the trip puts two different stops behind one name. "Move stop 1" then
     moves something the user was not looking at, and the agent reports success. */
  trailNumbers: Map<string, number>
  selectedPlaceId: string | null
  onSelectPlace: (placeId: string) => void
  legs?: TransportLeg[]
  placeIndex?: Map<string, Place>
  /* Covers only. Optional because the workspace does not pass it yet — without it every stop
     draws the same placeholder it draws for a stop that genuinely has no Reel. */
  bundle?: TripBundle
  /* place_id → seconds spent AT the place. No source is wired: see the block comment above
     `deriveEstimatedTimes` for why this is deliberately left unfed rather than defaulted. */
  dwellSeconds?: Map<string, number>
}) {
  const listRef = useRef<HTMLOListElement>(null)

  // A selection can arrive from somewhere the card list cannot see: a tap on a map pin, or the
  // agent calling show_on_map. On mobile that was invisible — the map's evidence popup opens
  // inside `.shared-map`, which is `position: fixed; z-index: 0` and therefore its own stacking
  // context, so the popup can never paint above the `z-10` details sheet covering ~65% of a
  // phone screen. No z-index fixes that. Bringing the matching CARD into view instead uses the
  // surface mobile already has, and fixes the agent's direction on desktop for free.
  useEffect(() => {
    if (!selectedPlaceId) return
    const card = listRef.current?.querySelector(`[data-place-id="${CSS.escape(selectedPlaceId)}"]`)
    // 'nearest' so a card already on screen does not jolt — clicking a card must not scroll it.
    card?.scrollIntoView({
      block: 'nearest',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    })
  }, [selectedPlaceId])

  if (places.length === 0) {
    return <p className="type-body text-sm text-[var(--muted)]">No stops planned for this day.</p>
  }
  const { above, trailing } = buildRouteLinks(places, legs, placeIndex)
  const estimates = deriveEstimatedTimes(places, above, dwellSeconds)
  const showTimes = estimates.some((e) => e !== null)
  return (
    <>
      {showTimes ? (
        <p className="type-label mb-1 px-3 text-[10px] uppercase tracking-wide text-[var(--faint)]">
          Est. times — assuming an 09:00 start, from the durations we hold
        </p>
      ) : null}
      <ol ref={listRef} className="flex flex-col">
        {places.map((tp, i) => {
          const selected = tp.place_id === selectedPlaceId
          const link = above[i]
          // Absent for a stop the map cannot pin (unresolved coordinates — `orderedTripPlaces`
          // drops it). It gets a marker with no number: the agent cannot address it either, and
          // printing one here would hand the user a handle that resolves to a different stop.
          const pin = trailNumbers.get(tp.id)
          const isLast = i === places.length - 1 && trailing.length === 0
          return (
            <li key={tp.id}>
              {/* The hop reads BEFORE the stop it delivers you to: "Akasaka Station → 3 min walk →
                  Harry Potter Cafe". With no leg to show, a bare rail segment still carries the eye
                  from one step to the next (most saved trips have no legs at all). */}
              {link
                ? <RouteLinkRow link={link} showTimes={showTimes} />
                : i > 0 ? <RailGap showTimes={showTimes} /> : null}
              <div className="flex items-stretch gap-2">
                <TimeCell show={showTimes} estimate={estimates[i]} />
                <button
                  type="button"
                  data-place-id={tp.place_id}
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => onSelectPlace(tp.place_id)}
                  className={[
                    'surface flex min-w-0 flex-1 items-stretch gap-3 rounded-xl px-3 text-left transition-colors',
                    selected ? 'border-[var(--brass)]' : 'hover:border-[var(--brass)]',
                  ].join(' ')}
                >
                  {/* The step marker sits ON the rail — the number becomes the anchor of the
                      sequence instead of a caption above the name, and it is the ONE saturated
                      accent on the panel. It reads "03" to the eye; screen readers get the
                      sentence below, and both say the number the map paints and the agent
                      answers to. */}
                  <RailCell
                    capTop={i === 0 && !link}
                    capBottom={isLast}
                    dot={
                      <span
                        className={[
                          'type-label flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                          'text-[10px] tabular-nums',
                          pin != null
                            ? 'bg-[var(--brass)] text-[var(--ink)]'
                            : 'border border-dashed border-[var(--line)]',
                        ].join(' ')}
                      >
                        {pin != null ? String(pin).padStart(2, '0') : ''}
                      </span>
                    }
                  />
                  <span className="sr-only">
                    {pin != null ? `Stop ${pin} of ${trailNumbers.size}` : 'Unnumbered stop'}
                  </span>
                  <div className="min-w-0 flex-1 py-3">
                    <div className="flex gap-3">
                      <Cover url={bundle ? thumbnailFor(bundle, tp) : null} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <h3 className="type-display truncate text-lg leading-tight text-[var(--starlight)]">
                            {tp.place.name}
                          </h3>
                          <span className="type-label shrink-0 rounded-[var(--radius-chip)] border border-[var(--line)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--muted)]">
                            {SOURCE_BADGE[tp.source_type]}
                          </span>
                        </div>
                        <p className="type-body mt-0.5 text-xs text-[var(--muted)]">
                          {[tp.place.place_type, tp.place.area, tp.place.city].filter(Boolean).join(' · ')}
                        </p>
                      </div>
                    </div>
                    {tp.evidence_json.quote && !addsNothing(tp.evidence_json.quote, tp.place.name) ? (
                      /* Compact quote preview: sans-italic on purpose — the serif quote face
                         never drops below 18px (DESIGN.md G2), and this caption is 12px. */
                      <p className="type-body mt-2 border-l border-[var(--brass)] pl-2 text-xs italic text-[var(--muted)]">
                        "{tp.evidence_json.quote}"
                      </p>
                    ) : null}
                    <div className="mt-2">
                      <EvidenceChip evidence={tp.evidence_json} />
                    </div>
                  </div>
                </button>
              </div>
              {/* A leg no stop on this day claimed — it leaves the last stop, or one of its
                  endpoints is missing. Shown after the route rather than dropped. */}
              {i === places.length - 1
                ? trailing.map((t) => <RouteLinkRow key={t.leg.id} link={t} showTimes={showTimes} />)
                : null}
            </li>
          )
        })}
      </ol>
    </>
  )
}
