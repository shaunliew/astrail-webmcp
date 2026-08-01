'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import type { Trip } from '@/lib/trip/backend-types'
import { listTrips } from '@/lib/trip/supabase-api'
import Astronaut from '@/components/mascot/Astronaut'
import TripRow from './TripRow'

// Deferred + client-only: keeps the 1.7MB Mapbox bundle out of the initial trips chunk
// (it loads when the desktop map pane mounts), and it touches window/mapbox so never SSRs.
const TripMapDashboard = dynamic(() => import('./TripMapDashboard'), { ssr: false })

/* /app/trips — three-pane dashboard.
     · left    the persistent nav rail (Sidebar, from the (shell) layout)
     · middle  this trip inventory: a paper list, select-in-place, brass-highlighted
     · right   the map of the selected trip — the shared fixed map showing through a window

   `data-fullbleed` tells the (shell) main to drop its padding and hand us the whole area
   edge-to-edge (see (shell)/layout.tsx). The inventory pane is opaque paper at z-10 so it
   masks the fixed map behind it; the right pane is left transparent so the map shows.

   The map pane is desktop-only (≥lg). Below that we show the inventory full-width and each
   row's "Open trip" link is the way into the workspace (which handles small screens itself).
   Gating on JS (not just CSS) matters: we must not *acquire* the fixed map on mobile, where
   the panes don't cover the viewport and it would bleed. */

function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia('(min-width: 1024px)')
    const update = () => setIsDesktop(mql.matches)
    update()
    mql.addEventListener('change', update)
    return () => mql.removeEventListener('change', update)
  }, [])
  return isDesktop
}

export default function TripsList() {
  const [trips, setTrips] = useState<Trip[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // No auto-select: you land on the idle spinning globe and the fly-in happens on YOUR click.
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const isDesktop = useIsDesktop()
  const mapWindowRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    let active = true
    listTrips()
      .then((t) => {
        if (active) setTrips(t)
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : 'Could not load trips.')
      })
    return () => {
      active = false
    }
  }, [])

  const hasTrips = trips !== null && trips.length > 0

  return (
    <div data-fullbleed className="flex h-full min-h-0">
      {/* Inventory pane — opaque paper, masks the fixed map on the left */}
      <section className="relative z-10 flex h-full min-h-0 w-full flex-col bg-[color:var(--surface-0)] lg:w-[380px] lg:flex-none lg:border-r lg:border-[color:var(--line-soft)]">
        <header className="flex items-center justify-between gap-3 px-5 pb-4 pt-6">
          <h1
            className="font-display text-[26px] text-[color:var(--text)]"
            style={{ fontVariationSettings: "'SOFT' 28, 'WONK' 1, 'opsz' 26" }}
          >
            My trips
          </h1>
          <Link
            href="/app"
            className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--brass-deep)] underline-offset-2 hover:underline"
          >
            New trip
          </Link>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6">
          {error ? (
            <p role="alert" className="px-2 text-xs text-[color:var(--fail)]">
              {error}
            </p>
          ) : null}

          {trips === null && !error ? (
            <p className="px-2 text-[11px] uppercase tracking-wide text-[color:var(--text-muted)]">
              Loading…
            </p>
          ) : null}

          {trips !== null && trips.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)] px-6 py-10 text-center">
              <Astronaut size={48} />
              <p className="text-sm text-[color:var(--text-muted)]">
                No trails yet. Your saved trips will land here.
              </p>
              <Link
                href="/app"
                className="rounded-lg border border-[color:var(--brass-deep)] px-4 py-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--brass-deep)] transition-colors hover:bg-[color:var(--brass-wash)]"
              >
                Plan your first trip
              </Link>
            </div>
          ) : null}

          {hasTrips ? (
            <ul className="flex flex-col gap-1.5">
              {trips.map((trip) => (
                <TripRow
                  key={trip.id}
                  trip={trip}
                  selected={trip.id === selectedId}
                  onSelect={() => setSelectedId(trip.id)}
                />
              ))}
            </ul>
          ) : null}
        </div>
      </section>

      {/* Map pane — desktop only; the shared fixed map shows through this transparent window */}
      {isDesktop ? (
        <section ref={mapWindowRef} className="relative min-h-0 flex-1" aria-label="Trip map">
          <TripMapDashboard selectedTripId={selectedId} windowRef={mapWindowRef} />
        </section>
      ) : null}
    </div>
  )
}
