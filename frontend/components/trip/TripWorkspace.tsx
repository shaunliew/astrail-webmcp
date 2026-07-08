'use client'

import { useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import type { TripBundle } from '@/lib/trip/backend-types'
import { getTrip } from '@/lib/trip/supabase-api'
import {
  orderedDays, placesForDay, legsForDay, restaurantsForDay,
  tripHotels, buildPlaceIndex, findTripPlace,
} from '@/lib/trip/selectors'
import DaySelector from './DaySelector'
import ItineraryCards from './ItineraryCards'
import TransportStrip from './TransportStrip'
import RestaurantStrip from './RestaurantStrip'
import HotelPanel from './HotelPanel'
import PlaceIntelPanel from './PlaceIntelPanel'
import OrchestratorSummary from './OrchestratorSummary'
import AgentDecisionRail from './AgentDecisionRail'

const TripMap = dynamic(() => import('@/components/map/TripMap'), { ssr: false })

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="type-label mb-2 text-[11px] uppercase tracking-wide text-[var(--faint)]">{title}</h3>
      {children}
    </section>
  )
}

export default function TripWorkspace({ tripId }: { tripId: string }) {
  const [bundle, setBundle] = useState<TripBundle | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'not_found'>('loading')
  const [activeDayNumber, setActiveDayNumber] = useState(1)
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

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

  if (status === 'loading') {
    return (
      <main className="flex h-[100dvh] items-center justify-center bg-[var(--void)]">
        <p className="type-label text-xs uppercase tracking-wide text-[var(--muted)]">Loading trip…</p>
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
        <a href="/app" className="type-label text-xs uppercase tracking-wide text-[var(--brass)] underline-offset-2 hover:underline">
          Plan a new trip
        </a>
      </main>
    )
  }
  if (bundle.trip.status === 'generating' || bundle.trip.status === 'draft') {
    return (
      <main className="flex h-[100dvh] flex-col items-center justify-center gap-3 bg-[var(--void)] p-6">
        <p className="type-label text-xs uppercase tracking-wide text-[var(--muted)]">
          Still generating — refresh in a moment.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="type-label text-xs uppercase tracking-wide text-[var(--brass)] underline-offset-2 hover:underline"
        >
          Refresh
        </button>
      </main>
    )
  }

  return (
    <main className="relative h-[100dvh] w-full overflow-hidden bg-[var(--void)]">
      <div className="absolute inset-0">
        <TripMap
          bundle={bundle}
          activeDayNumber={activeDayNumber}
          selectedPlaceId={selectedPlaceId}
          onSelectPlace={(id) => { setSelectedPlaceId(id); setExpanded(true) }}
        />
      </div>

      <aside
        className={[
          'absolute z-10 overflow-y-auto surface backdrop-blur-sm',
          'inset-x-0 bottom-0 rounded-t-2xl transition-[height] duration-300 ease-out',
          expanded ? 'h-[82dvh]' : 'h-[42dvh]',
          'md:inset-y-0 md:left-0 md:right-auto md:h-full md:w-[440px] md:rounded-none md:rounded-r-2xl',
        ].join(' ')}
        aria-label="Trip details"
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mx-auto mt-2 mb-1 block h-1.5 w-10 rounded-full bg-[var(--line)] md:hidden"
          aria-label={expanded ? 'Collapse panel' : 'Expand panel'}
        />
        <div className="p-4">
          <OrchestratorSummary bundle={bundle} />

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
