'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import type { TripBundle } from '@/lib/trip/backend-types'
import { getTrip } from '@/lib/trip/supabase-api'
import TripTools from '@/components/webmcp/TripTools'
import {
  orderedDays, placesForDay, legsForDay, restaurantsForDay,
  tripHotels, buildPlaceIndex, findTripPlace, recommendedHotelId,
} from '@/lib/trip/selectors'
import { useSharedMap } from '@/components/map/MapProvider'
import { useOptionalGeneration } from '@/components/generation/GenerationProvider'
import Astronaut from '@/components/mascot/Astronaut'
import DaySelector from './DaySelector'
import DayOverview from './DayOverview'
import ItineraryCards from './ItineraryCards'
import TransportStrip from './TransportStrip'
import RestaurantStrip from './RestaurantStrip'
import HotelPanel from './HotelPanel'
import PlaceIntelPanel from './PlaceIntelPanel'
import OrchestratorSummary from './OrchestratorSummary'
import AgentDecisionRail from './AgentDecisionRail'
import TradeoffPanel from './TradeoffPanel'
import TripFeedbackPanel from './TripFeedbackPanel'

const TripMap = dynamic(() => import('@/components/map/TripMap'), { ssr: false })

// Base chevron points right (›). Callers rotate it to point up/down/left per state.
function Chevron({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden
      className={['h-4 w-4', className ?? ''].join(' ')}
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  )
}

// Shared chrome for both panel toggles: a cream pill that reads on paper and over the map.
// `paper-scope` on the reopen tab (which lives outside the panel) makes these vars resolve
// to the same paper palette as the in-panel collapse control.
const TOGGLE_CHROME =
  'flex items-center justify-center rounded-full border border-[var(--line)] ' +
  'bg-[rgba(253,251,245,0.94)] text-[var(--muted)] backdrop-blur-sm ' +
  'shadow-[0_2px_12px_rgba(0,0,0,0.2)] transition-opacity duration-200 hover:text-[var(--starlight)]'

// One segment of the map layer switch (Route ⇄ Hotel). The active segment gets the brass fill;
// the rest read as a muted, tappable label — same paper palette as the panel toggles above.
function segClass(active: boolean): string {
  return [
    'type-label rounded-full px-3 py-1 text-[11px] uppercase tracking-wide transition-colors',
    active ? 'bg-[var(--brass-soft)] text-[var(--brass-bright)]' : 'text-[var(--muted)] hover:text-[var(--starlight)]',
  ].join(' ')
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      {/* Serif sentence-case headers — the uppercase-eyebrow-on-every-section cadence is
          the classic generated-UI tell; uppercase micro-labels stay reserved for form
          labels and data captions. */}
      <h3 className="type-display mb-2 text-[15px] text-[var(--starlight)]">{title}</h3>
      {children}
    </section>
  )
}

/**
 * @param bundle    A trip supplied directly, instead of read from Supabase. `/app/trip/demo`
 *                  passes the Tokyo fixture so a judge can see a real 3D trail with no account,
 *                  no generation and nothing spent. Omit it and the fetch path below is unchanged.
 * @param readOnly  There is no database row behind a seeded bundle, so nothing that writes may be
 *                  offered against it — see the feedback composer below and the open-trip ref in
 *                  <TripTools/>. Also labels the page, so the agent does not attempt an edit.
 */
export default function TripWorkspace({
  tripId,
  bundle: seeded,
  readOnly = false,
}: {
  tripId: string
  bundle?: TripBundle
  readOnly?: boolean
}) {
  const { acquire, release } = useSharedMap()
  /**
   * Did the run the shell just finished produce THIS trip?
   *
   * Only used to decide what the loading frame says, and it is a backed claim, not optimism:
   * `complete` is set from a result frame whose verdict was success, and that same verdict is the
   * only one that navigates here at all. Matching the id matters — a finished run must not put
   * "your trip is ready" on some other trip the user opens next.
   *
   * Optional, because this component renders outside the /app shell too (nothing else in it needs
   * a generation), and null simply means there is no arrival to continue from.
   */
  const shellRun = useOptionalGeneration()?.run ?? null
  const arrivingFromGeneration = shellRun?.status === 'complete' && shellRun.tripId === tripId
  const [bundle, setBundle] = useState<TripBundle | null>(seeded ?? null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'not_found'>(seeded ? 'ready' : 'loading')
  const [activeDayNumber, setActiveDayNumber] = useState(() => (seeded ? orderedDays(seeded)[0]?.day_number ?? 1 : 1))
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null)
  // Hotel-hub map (plan 2026-08-04-hotel-hub-map, T8) — ephemeral client state, no DB write.
  // Default selection = the route-central hotel (rank 1), which is `null` when NO hotel was
  // geocoded (honest-failure, C5); default layer = the existing itinerary route line.
  const [selectedHotelId, setSelectedHotelId] = useState<string | null>(() =>
    seeded ? recommendedHotelId(seeded) : null,
  )
  const [layerMode, setLayerMode] = useState<'route' | 'hub'>('route')
  const [expanded, setExpanded] = useState(false)
  const [panelOpen, setPanelOpen] = useState(true)
  // A "Where to eat" suggestion the user picked from the panel, so the map can show where it is.
  const [selectedRestaurantPlaceId, setSelectedRestaurantPlaceId] = useState<string | null>(null)

  useEffect(() => {
    // A seeded bundle is already the answer, and there is nothing to read: the fixture has no
    // row. Returning before `setStatus('loading')` is what keeps the sample from flashing a
    // loading screen it would never leave.
    if (seeded) return
    let active = true
    setStatus('loading')
    getTrip(tripId).then((b) => {
      if (!active) return
      if (!b) { setStatus('not_found'); return }
      setBundle(b)
      setActiveDayNumber(orderedDays(b)[0]?.day_number ?? 1)
      setSelectedHotelId(recommendedHotelId(b))
      setStatus('ready')
    })
    return () => { active = false }
  }, [tripId, seeded])

  // Re-reads the trip INTO this page's state. Published to the WebMCP registry so an agent edit
  // becomes visible immediately; previously every change needed a manual page refresh.
  const refreshBundle = useCallback(async () => {
    // A seeded bundle IS the current state and `tripId` names no row, so re-reading would ask
    // Supabase for a trip that does not exist and answer null.
    if (seeded) return seeded
    const fresh = await getTrip(tripId)
    if (fresh) setBundle(fresh)
    return fresh
  }, [tripId, seeded])

  const days = useMemo(() => (bundle ? orderedDays(bundle) : []), [bundle])
  const placeIndex = useMemo(() => (bundle ? buildPlaceIndex(bundle) : new Map()), [bundle])
  // No hotel got a coordinate ⇒ the hub layer has nothing to draw, so the Hotel toggle is
  // disabled rather than flipping to a silently blank map (C5). Same signal that seeds the
  // default selection above, so "toggle enabled" and "a hub is selected" never disagree.
  const canUseHubLayer = useMemo(() => (bundle ? recommendedHotelId(bundle) !== null : false), [bundle])
  const activeDay = days.find((d) => d.day_number === activeDayNumber) ?? null
  const dayPlaces = bundle ? placesForDay(bundle, activeDayNumber) : []
  const dayLegs = bundle && activeDay ? legsForDay(bundle, activeDay.id) : []
  const dayRestaurants = bundle && activeDay ? restaurantsForDay(bundle, activeDay.id) : []
  const selectedTripPlace = bundle ? findTripPlace(bundle, selectedPlaceId) : null

  // Hold the shell map on screen while the trip loads and while it is still generating.
  // The night->dawn relight fires as generation completes and lands in exactly these
  // states — a full-bleed takeover here would hide the signature moment behind a
  // loading screen. Inert, because there is nothing to explore until the bundle lands.
  const mapBehind = status === 'loading'
    || (bundle !== null && (bundle.trip.status === 'generating' || bundle.trip.status === 'draft'))

  useEffect(() => {
    if (!mapBehind) return
    acquire({ interactive: false, lightPreset: 'dawn' })
    return () => release()
  }, [mapBehind, acquire, release])

  if (status === 'loading') {
    return (
      <main className="relative flex h-[100dvh] items-center justify-center p-6">
        {arrivingFromGeneration ? (
          /* The arrival, not a new page. The shell pushes here the instant the result frame
             lands, and everything that framed the wait screen — the narration rail, the sidebar —
             goes at once, so the bare pill below read to the first user who saw it as being
             dumped back on the home page before his trip appeared. This carries the rail's last
             words and its astronaut across the handoff; the dawn map behind it never moved. The
             dot is live because the page genuinely is still working: the trip is ready, the read
             is not. Confined to this branch, so it cannot outlive the open outcome — a read that
             answers not-found or failed falls through to those screens below. */
          <div data-testid="trip-arrival" className="surface flex items-center gap-3 px-5 py-4">
            <Astronaut size={40} variant="idle" />
            <div>
              <p className="type-display text-[15px] text-[var(--starlight)]">Your trip is ready</p>
              <p className="type-label flex items-center gap-2 text-xs uppercase tracking-wide text-[var(--muted)]">
                <span aria-hidden className="pulse-dot pulse-dot--live" />
                Opening your map…
              </p>
            </div>
          </div>
        ) : (
          <p className="surface type-label px-4 py-2.5 text-xs uppercase tracking-wide text-[var(--muted)]">Loading trip…</p>
        )}
      </main>
    )
  }
  if (status === 'not_found' || !bundle) {
    return (
      <main className="flex h-[100dvh] items-center justify-center bg-[var(--void)]">
        <p className="type-body text-sm text-[var(--muted)]">Trip not found.</p>
      </main>
    )
  }
  if (bundle.trip.status === 'failed') {
    // Failed trips are where feedback is the most valuable beta signal (HANDOFF.md — "don't hide
    // the UI on failures"), so the composer mounts here too. min-h + overflow-y-auto (not a rigid
    // h-[100dvh] + justify-center) so the composer never clips on short/mobile viewports with the
    // keyboard open; the screen stays centered when the content fits. Night tokens from :root are
    // correct here — do NOT wrap in paper-scope.
    return (
      <main className="flex min-h-[100dvh] flex-col items-center justify-center gap-3 overflow-y-auto bg-[var(--void)] p-6">
        <p className="type-display text-xl text-[var(--starlight)]">Generation failed</p>
        <p className="type-body max-w-md text-center text-sm text-[var(--muted)]">
          Astrail couldn&apos;t build this trip. Start a new one — repeat Reels are cached, so retrying is fast.
        </p>
        <a href="/app" className="type-label text-xs uppercase tracking-wide text-[var(--brass-bright)] underline-offset-2 hover:underline">
          Plan a new trip
        </a>
        {/* Same gate as the composer in the main return: a seeded bundle has no trip row for
            feedback to reference, so the invitation goes with it rather than standing alone. */}
        {!readOnly && (
          <>
            <p className="type-body max-w-md text-center text-sm text-[var(--muted)]">
              Tell us what went wrong — it&apos;s the most useful feedback we get.
            </p>
            <div className="w-full max-w-md">
              <TripFeedbackPanel key={bundle.trip.id} tripId={bundle.trip.id} />
            </div>
          </>
        )}
      </main>
    )
  }
  if (bundle.trip.status === 'generating' || bundle.trip.status === 'draft') {
    return (
      <main className="relative flex h-[100dvh] flex-col items-center justify-center p-6">
        <div className="surface flex flex-col items-center gap-3 px-5 py-4">
          <p className="type-label text-xs uppercase tracking-wide text-[var(--muted)]">
            Still generating — refresh in a moment.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="type-label text-xs uppercase tracking-wide text-[var(--brass-bright)] underline-offset-2 hover:underline"
          >
            Refresh
          </button>
        </div>
      </main>
    )
  }

  /* The map shows every day's pins, but the itinerary list below shows only the ACTIVE day —
     so selecting a Day 3 pin while Day 1 is open used to open the panel on a list that does not
     contain it: no card to highlight, and nothing to scroll to. Activating the place's own day
     is the parent's job, since the day is the parent's state. Both setters run in one handler,
     so the list and the selection arrive on the same render. An undayed stop (the base hotel)
     leaves the day alone — there is no day to switch to. */
  function selectPlaceFromMap(placeId: string) {
    // Optional chain only to satisfy TS: a hoisted function declaration is not narrowed by the
    // early return above, though at runtime bundle is non-null by the time this can be called.
    const day = bundle?.places.find((tp) => tp.place_id === placeId)?.day_number
    if (typeof day === 'number') setActiveDayNumber(day)
    setSelectedPlaceId(placeId)
    setExpanded(true)
    setPanelOpen(true)
  }

  return (
    <>
      {/* Map-driving tools live only where a map exists. key={tripId} guarantees trip A's
          registrations unmount before trip B's mount, so two same-named tools never overlap. */}
      <TripTools
        key={tripId}
        bundle={bundle}
        showDay={setActiveDayNumber}
        selectPlace={setSelectedPlaceId}
        setLayerMode={setLayerMode}
        openPanel={() => setPanelOpen(true)}
        refresh={refreshBundle}
        readOnly={readOnly}
      />
    {/* The interactive Mapbox canvas is a FIXED layer behind this route (MapProvider's
        `.shared-map`). This overlay must be click-through, or it swallows every pan/zoom/
        pin-tap before the map beneath ever sees it. Interactive children re-enable
        pointer events explicitly (the panel + its buttons below).

        A BRACED comment, not bare `//`. Inside JSX a `//` line is not a comment — it is a text child,
        so these four lines RENDERED, took 48px of flow, and pushed <main> (which is 100dvh
        tall) that far down the page. The visible symptom was a strip of map above the details
        panel and 48px of the panel hanging below the fold. Invisible as text only because it
        is dark-on-dark. */}
    <main className="pointer-events-none relative h-[100dvh] w-full overflow-hidden">
      <div className="pointer-events-none absolute inset-0">
        <TripMap
          bundle={bundle}
          activeDayNumber={activeDayNumber}
          selectedPlaceId={selectedPlaceId}
          selectedRestaurantPlaceId={selectedRestaurantPlaceId}
          onSelectRestaurant={setSelectedRestaurantPlaceId}
          onSelectPlace={(id) => selectPlaceFromMap(id)}
          selectedHotelId={selectedHotelId}
          layerMode={layerMode}
        />
      </div>

      {/* Map layer switch — route line vs. hotel hub-and-spokes, never both (plan decision #3).
          Floats over the map, clear of the left/bottom details panel. The Hotel segment is
          disabled when no hotel could be placed, so it never flips to a blank map (C5). */}
      <div
        role="group"
        aria-label="Map layer"
        className={[
          'paper-scope pointer-events-auto absolute z-20 left-1/2 top-4 -translate-x-1/2',
          'flex items-center gap-0.5 rounded-full border border-[var(--line)]',
          'bg-[rgba(253,251,245,0.94)] p-0.5 shadow-[0_2px_12px_rgba(0,0,0,0.2)] backdrop-blur-sm',
        ].join(' ')}
      >
        <button
          type="button"
          onClick={() => setLayerMode('route')}
          aria-pressed={layerMode === 'route'}
          className={segClass(layerMode === 'route')}
        >
          Route
        </button>
        <button
          type="button"
          onClick={() => setLayerMode('hub')}
          aria-pressed={layerMode === 'hub'}
          disabled={!canUseHubLayer}
          title={canUseHubLayer ? undefined : 'No hotel could be placed on the map'}
          className={[segClass(layerMode === 'hub'), canUseHubLayer ? '' : 'cursor-not-allowed opacity-40'].join(' ')}
        >
          Hotel
        </button>
      </div>

      <aside
        id="trip-details-panel"
        className={[
          'trip-details-panel pointer-events-auto absolute z-10 paper-scope bg-[rgba(243,238,226,0.55)] backdrop-blur-sm',
          'inset-x-0 bottom-0 rounded-t-[var(--radius-card)] transition-all duration-300 ease-out',
          expanded ? 'h-[82dvh]' : 'h-[42dvh]',
          panelOpen ? 'translate-y-[0%]' : 'translate-y-[100%]',
          // Desktop pins translate-y to 0 so the mobile close (translate-y-[100%]) never
          // composes with the horizontal slide into a diagonal — the edge tab rides this
          // transform, so a stray Y offset would fling it off-screen when collapsed.
          'md:inset-y-0 md:left-0 md:right-auto md:h-full md:w-[440px] md:rounded-none md:rounded-r-[var(--radius-card)] md:translate-y-[0%]',
          panelOpen ? 'md:translate-x-[0%]' : 'md:translate-x-[-100%]',
        ].join(' ')}
        aria-label="Trip details"
      >
        {/* Collapse control — docked INSIDE the panel edge (never overhanging the map).
            Pinned as a direct child of the aside so it stays put while the content scrolls,
            and rides the panel's slide out when collapsed. Its twin, the reopen tab below,
            takes over at the screen edge once the panel is gone. */}
        <button
          type="button"
          onClick={() => setPanelOpen(false)}
          aria-label="Hide trip details and show the full map"
          aria-expanded={panelOpen}
          aria-controls="trip-details-scroll"
          aria-hidden={!panelOpen}
          tabIndex={panelOpen ? 0 : -1}
          className={[
            TOGGLE_CHROME,
            'absolute z-20',
            panelOpen ? 'opacity-100' : 'opacity-0 pointer-events-none',
            // mobile: top-right corner inside the sheet, clear of the centered drag handle
            'h-7 w-12 right-3 top-2',
            // desktop: vertical pill inset from the right edge, vertically centered
            'md:h-14 md:w-7 md:top-1/2 md:-translate-y-1/2',
          ].join(' ')}
        >
          <Chevron className="rotate-90 md:rotate-180" />
        </button>

        {/* Scrollable content — inert (skipped by pointers, tab order, and AT) while hidden. */}
        <div
          id="trip-details-scroll"
          className="h-full overflow-y-auto rounded-[inherit]"
          inert={!panelOpen}
        >
        <div className="relative shrink-0 px-2 pt-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="mx-auto block h-1.5 w-10 rounded-full bg-[var(--line)] md:hidden"
            aria-label={expanded ? 'Collapse panel' : 'Expand panel'}
          />
        </div>
        <div className="p-4 pt-1">
          {/* Up-nav — this route lives OUTSIDE the (shell) layout, so it has no sidebar; without
              this link the workspace is a dead end. Lands on /app/trips, which restores the full
              sidebar (Home · Trails · Settings). */}
          <Link
            href="/app/trips"
            className="type-label mb-3 inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-[var(--muted)] transition-colors hover:text-[var(--starlight)]"
          >
            <svg
              viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              strokeLinecap="round" strokeLinejoin="round" aria-hidden className="h-3.5 w-3.5"
            >
              <polyline points="15 6 9 12 15 18" />
            </svg>
            All trails
          </Link>
          {/* Said in the page, not only in the tool layer: an agent reading this workspace should
              know before it tries that nothing here writes. The reviewer's exact ask — "label the
              page so the agent is not set up to fail". */}
          {readOnly && (
            <div className="mb-3">
              <p className="type-label inline-block rounded-full bg-[var(--brass-soft)] px-3 py-1 text-[11px] uppercase tracking-wide text-[var(--brass-bright)]">
                Sample trail — read-only
              </p>
              <p className="type-body mt-1.5 text-xs text-[var(--muted)]">
                A saved example, not an account. Nothing here can be changed or saved — plan your
                own trail to edit an itinerary.
              </p>
            </div>
          )}
          <OrchestratorSummary bundle={bundle} />
          {/* Day-pacing notes only ("Heads up") — the hotel comparison lives with the hotel
              list under "Where to stay" so there is ONE hotel decision surface, not two. */}
          <TradeoffPanel tradeoffs={bundle.trip.tradeoffs} variant="notes" />

          <Section title="Days">
            <DaySelector days={days} activeDayNumber={activeDayNumber} onSelect={setActiveDayNumber} />
          </Section>

          <Section title="Itinerary">
            <div className="flex flex-col gap-3">
              {activeDay ? <DayOverview day={activeDay} /> : null}
              <ItineraryCards places={dayPlaces} selectedPlaceId={selectedPlaceId} onSelectPlace={setSelectedPlaceId} />
            </div>
          </Section>

          <Section title="Getting around">
            <TransportStrip legs={dayLegs} placeIndex={placeIndex} />
          </Section>

          <Section title="Where to eat">
            <RestaurantStrip
              restaurants={dayRestaurants}
              placeIndex={placeIndex}
              selectedPlaceId={selectedRestaurantPlaceId}
              onSelect={setSelectedRestaurantPlaceId}
            />
          </Section>

          <Section title="Where to stay">
            <div className="flex flex-col gap-3">
              {/* Price-vs-rating context sits WITH the hotels it compares. It is context, not a
                  second pick — the Recommended badge on the list below stays the single pick. */}
              <TradeoffPanel tradeoffs={bundle.trip.tradeoffs} variant="comparisons" />
              <HotelPanel
                hotels={tripHotels(bundle)}
                selectedHotelId={selectedHotelId}
                onSelectHotel={setSelectedHotelId}
                layerMode={layerMode}
              />
            </div>
          </Section>

          <Section title="Place detail">
            <PlaceIntelPanel tripPlace={selectedTripPlace} />
          </Section>

          <Section title="How Astrail built this">
            <AgentDecisionRail events={bundle.events} />
          </Section>

          {/* Feedback composer — explicit status allowlist (plan T3), NOT reachability:
              places_ready falls through to this return and must NOT show the panel. `key` +
              bundle.trip.id bind the panel to the LOADED trip and reset its state across a
              trip-to-trip route transition. */}
          {!readOnly && (bundle.trip.status === 'complete' || bundle.trip.status === 'saved_with_gaps') && (
            <Section title="How was this trail?">
              <TripFeedbackPanel key={bundle.trip.id} tripId={bundle.trip.id} />
            </Section>
          )}
        </div>
        </div>
      </aside>

      {/* Reopen tab — the collapse control's twin. Sits at the screen edge (a sibling of the
          panel, so it stays put while the panel is off-screen) and fades in once the panel
          is tucked away, so collapsing is never a dead end. */}
      <button
        type="button"
        onClick={() => setPanelOpen(true)}
        aria-label="Show trip details"
        aria-expanded={panelOpen}
        aria-controls="trip-details-scroll"
        aria-hidden={panelOpen}
        tabIndex={panelOpen ? -1 : 0}
        className={[
          TOGGLE_CHROME,
          'paper-scope pointer-events-auto absolute z-20',
          panelOpen ? 'opacity-0 pointer-events-none' : 'opacity-100',
          // mobile: horizontal pill peeking at the bottom-center
          'h-7 w-12 bottom-4 left-1/2 -translate-x-1/2',
          // desktop: vertical tab on the far-left screen edge, vertically centered
          'md:h-14 md:w-7 md:bottom-auto md:left-0 md:top-1/2 md:translate-x-0 md:-translate-y-1/2',
        ].join(' ')}
      >
        <Chevron className="-rotate-90 md:rotate-0" />
      </button>
    </main>
    </>
  )
}
