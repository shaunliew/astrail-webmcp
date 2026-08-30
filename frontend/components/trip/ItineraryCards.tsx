'use client'

import { useEffect, useRef } from 'react'
import type { TripPlace, PlaceSourceType, TransportLeg, Place } from '@/lib/trip/backend-types'
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

/* The rail. It is what turns a stack of cards into one continuous route: a dashed line running
   through every step marker, carrying the hop between them. Dashed rather than solid on purpose —
   the card's own padding breaks the line at each marker, and a dashed line reads as a path rather
   than as a rule someone forgot to join up. */
function Rail({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex gap-3 px-3">
      <span aria-hidden className="flex w-6 shrink-0 justify-center">
        <span className="border-l border-dashed border-[var(--line)]" />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function RouteLinkRow({ link }: { link: RouteLink }) {
  const { leg, from } = link
  const routed = leg.status === 'ok'
  const timing = [
    fmtDuration(leg.duration_seconds),
    leg.distance_meters != null ? `${(leg.distance_meters / 1000).toFixed(1)} km` : '',
  ].filter(Boolean).join(' · ')
  return (
    <Rail>
      <p className="type-label py-1.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
        {from ? <span className="text-[var(--faint)]">from {from} · </span> : null}
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
    </Rail>
  )
}

export default function ItineraryCards({
  places, selectedPlaceId, onSelectPlace, legs = [], placeIndex,
}: {
  places: TripPlace[]
  selectedPlaceId: string | null
  onSelectPlace: (placeId: string) => void
  legs?: TransportLeg[]
  placeIndex?: Map<string, Place>
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
  return (
    <ol ref={listRef} className="flex flex-col">
      {places.map((tp, i) => {
        const selected = tp.place_id === selectedPlaceId
        const link = above[i]
        return (
          <li key={tp.id}>
            {/* The hop reads BEFORE the stop it delivers you to: "Akasaka Station → 3 min walk →
                Harry Potter Cafe". With no leg to show, a bare rail segment still carries the eye
                from one step to the next (most saved trips have no legs at all). */}
            {link ? <RouteLinkRow link={link} /> : i > 0 ? <Rail><span className="block h-3" /></Rail> : null}
            <button
              type="button"
              data-place-id={tp.place_id}
              aria-current={selected ? 'true' : undefined}
              onClick={() => onSelectPlace(tp.place_id)}
              className={[
                'surface flex w-full gap-3 rounded-xl p-3 text-left transition-colors',
                selected ? 'border-[var(--brass)]' : 'hover:border-[var(--brass)]',
              ].join(' ')}
            >
              {/* The step marker sits ON the rail — the number becomes the anchor of the sequence
                  instead of a caption above the name, which also buys back the line it used to
                  occupy. It reads "01" to the eye; screen readers get the sentence below. */}
              <span
                aria-hidden
                className="type-label mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-[var(--brass)] bg-[var(--brass-soft)] text-[10px] tabular-nums text-[var(--brass-bright)]"
              >
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="sr-only">Stop {i + 1} of {places.length}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="type-display truncate text-lg leading-tight text-[var(--starlight)]">
                      {tp.place.name}
                    </h3>
                    <p className="type-body text-xs text-[var(--muted)]">
                      {[tp.place.place_type, tp.place.area, tp.place.city].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <span className="type-label shrink-0 rounded-[var(--radius-chip)] border border-[var(--line)] px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-[var(--muted)]">
                    {SOURCE_BADGE[tp.source_type]}
                  </span>
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
            {/* A leg no stop on this day claimed — it leaves the last stop, or one of its
                endpoints is missing. Shown after the route rather than dropped. */}
            {i === places.length - 1
              ? trailing.map((t) => <RouteLinkRow key={t.leg.id} link={t} />)
              : null}
          </li>
        )
      })}
    </ol>
  )
}
