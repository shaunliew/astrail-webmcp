'use client'

import { useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import type { TripBundle } from '@/lib/trip/backend-types'
import { getTrip } from '@/lib/trip/supabase-api'
import {
  orderedDays, placesForDay, legsForDay, restaurantsForDay,
  tripHotels, buildPlaceIndex, findTripPlace,
} from '@/lib/trip/selectors'
import { useSharedMap } from '@/components/map/MapProvider'
import DaySelector from './DaySelector'
import ItineraryCards from './ItineraryCards'
import TransportStrip from './TransportStrip'
import RestaurantStrip from './RestaurantStrip'
import HotelPanel from './HotelPanel'
import PlaceIntelPanel from './PlaceIntelPanel'
import OrchestratorSummary from './OrchestratorSummary'
import AgentDecisionRail from './AgentDecisionRail'
import TradeoffPanel from './TradeoffPanel'

const TripMap = dynamic(() => import('@/components/map/TripMap'), { ssr: false })

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

export default function TripWorkspace({ tripId }: { tripId: string }) {
  const { acquire, release } = useSharedMap()
  const [bundle, setBundle] = useState<TripBundle | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'not_found'>('loading')
  const [activeDayNumber, setActiveDayNumber] = useState(1)
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [panelOpen, setPanelOpen] = useState(true)

  useEffect(() => {
    let active = true
    setStatus('loading')
    getTrip(tripId).then((b) => {
      if (!active) return
      if (!b) { setStatus('not_found'); return }
      setBundle(b)
      setActiveDayNumber(orderedDays(b)[0]?.day_number ?? 1)
      setStatus('ready')
    })
    return () => { active = false }
  }, [tripId])

  const days = useMemo(() => (bundle ? orderedDays(bundle) : []), [bundle])
  const placeIndex = useMemo(() => (bundle ? buildPlaceIndex(bundle) : new Map()), [bundle])
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
        <p className="surface type-label px-4 py-2.5 text-xs uppercase tracking-wide text-[var(--muted)]">Loading trip…</p>
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
    return (
      <main className="flex h-[100dvh] flex-col items-center justify-center gap-3 bg-[var(--void)] p-6">
        <p className="type-display text-xl text-[var(--starlight)]">Generation failed</p>
        <p className="type-body max-w-md text-center text-sm text-[var(--muted)]">
          Astrail couldn&apos;t build this trip. Start a new one — repeat Reels are cached, so retrying is fast.
        </p>
        <a href="/app" className="type-label text-xs uppercase tracking-wide text-[var(--brass-bright)] underline-offset-2 hover:underline">
          Plan a new trip
        </a>
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

  return (
    <main className="relative h-[100dvh] w-full overflow-hidden">
      <div className="absolute inset-0">
        <TripMap
          bundle={bundle}
          activeDayNumber={activeDayNumber}
          selectedPlaceId={selectedPlaceId}
          onSelectPlace={(id) => { setSelectedPlaceId(id); setExpanded(true); setPanelOpen(true) }}
        />
      </div>

      {/* Reopen affordance: floats over the map while the panel is hidden, so
          closing it is never a dead end. */}
      {!panelOpen ? (
        <button
          type="button"
          onClick={() => setPanelOpen(true)}
          className="surface type-label absolute inset-x-0 bottom-5 z-10 mx-auto flex w-fit items-center gap-2 rounded-full px-4 py-2.5 text-[11px] uppercase tracking-wide text-[var(--starlight)] md:inset-x-auto md:inset-y-0 md:left-5 md:my-auto md:h-fit"
        >
          <span aria-hidden>&uarr;</span>
          Trip details
        </button>
      ) : null}

      <aside
        className={[
          'trip-details-panel absolute z-10 overflow-y-auto paper-scope bg-[rgba(243,238,226,0.55)] backdrop-blur-sm',
          'inset-x-0 bottom-0 rounded-t-[var(--radius-card)] transition-all duration-300 ease-out',
          expanded ? 'h-[82dvh]' : 'h-[42dvh]',
          panelOpen ? 'translate-y-[0%]' : 'translate-y-[100%]',
          'md:inset-y-0 md:left-0 md:right-auto md:h-full md:w-[440px] md:rounded-none md:rounded-r-[var(--radius-card)]',
          panelOpen ? 'md:translate-x-[0%]' : 'md:translate-x-[-100%]',
        ].join(' ')}
        aria-label="Trip details"
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
          <button
            type="button"
            onClick={() => setPanelOpen(false)}
            aria-label="Hide trip details and show the full map"
            className="type-label absolute right-2 top-2 rounded-[var(--radius-chip)] px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--faint)] transition-colors hover:bg-[var(--chip-bg)] hover:text-[var(--muted)]"
          >
            Hide
          </button>
        </div>
        <div className="p-4 pt-1">
          <OrchestratorSummary bundle={bundle} />
          <TradeoffPanel tradeoffs={bundle.trip.tradeoffs} />

          <Section title="Days">
            <DaySelector days={days} activeDayNumber={activeDayNumber} onSelect={setActiveDayNumber} />
          </Section>

          <Section title="Itinerary">
            <ItineraryCards places={dayPlaces} selectedPlaceId={selectedPlaceId} onSelectPlace={setSelectedPlaceId} />
          </Section>

          <Section title="Getting around">
            <TransportStrip legs={dayLegs} placeIndex={placeIndex} />
          </Section>

          <Section title="Where to eat">
            <RestaurantStrip restaurants={dayRestaurants} placeIndex={placeIndex} />
          </Section>

          <Section title="Where to stay">
            <HotelPanel hotels={tripHotels(bundle)} />
          </Section>

          <Section title="Place detail">
            <PlaceIntelPanel tripPlace={selectedTripPlace} />
          </Section>

          <Section title="How Astrail built this">
            <AgentDecisionRail events={bundle.events} />
          </Section>
        </div>
      </aside>
    </main>
  )
}
