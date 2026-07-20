'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Trip } from '@/lib/trip/backend-types'
import { listTrips } from '@/lib/trip/supabase-api'
import SignOutButton from '@/components/auth/SignOutButton'
import TripCard from './TripCard'
import Astronaut from '@/components/mascot/Astronaut'

export default function TripsList() {
  const [trips, setTrips] = useState<Trip[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    listTrips()
      .then((t) => { if (active) setTrips(t) })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : 'Could not load trips.') })
    return () => { active = false }
  }, [])

  return (
    <main className="app-shell min-h-[100dvh] bg-[var(--paper-1)]">
      <div className="paper-scope mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col gap-6 bg-[var(--paper-1)] p-6">
        <header className="flex items-center justify-between">
          <h1 className="type-display text-3xl text-[var(--starlight)]">My trips</h1>
          <div className="flex items-center gap-4">
            <Link
              href="/app"
              className="type-label text-[11px] uppercase tracking-wide text-[var(--brass-deep)] underline-offset-2 hover:underline"
            >
              New trip
            </Link>
            <SignOutButton />
          </div>
        </header>

        {error ? <p className="type-body text-xs text-[var(--fail)]" role="alert">{error}</p> : null}
        {trips === null && !error ? (
          <p className="type-label text-xs uppercase tracking-wide text-[var(--muted)]">Loading…</p>
        ) : null}
        {trips !== null && trips.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-[var(--radius-card)] border border-dashed border-[rgba(138,96,35,0.35)] bg-[var(--paper-0)] px-6 py-10 text-center">
            <Astronaut size={48} />
            <p className="type-body text-sm text-[var(--muted)]">
              No trails yet. Your saved trips will land here.
            </p>
            <Link
              href="/app"
              className="type-label rounded-lg border border-[var(--brass-deep)] bg-[var(--brass-soft)] px-4 py-2 text-xs uppercase tracking-wide text-[var(--ink-day)] transition-colors hover:bg-[rgba(138,96,35,0.2)]"
            >
              Plan your first trip
            </Link>
          </div>
        ) : null}

        <ul className="flex flex-col gap-3">
          {(trips ?? []).map((trip) => (
            <li key={trip.id}>
              <TripCard trip={trip} />
            </li>
          ))}
        </ul>
      </div>
    </main>
  )
}
