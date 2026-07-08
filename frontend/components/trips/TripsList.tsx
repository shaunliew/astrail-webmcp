'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { Trip } from '@/lib/trip/backend-types'
import { listTrips } from '@/lib/trip/supabase-api'
import SignOutButton from '@/components/auth/SignOutButton'

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
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col gap-6 bg-[var(--void)] p-6">
      <header className="flex items-center justify-between">
        <h1 className="type-display text-3xl text-[var(--starlight)]">My trips</h1>
        <div className="flex items-center gap-4">
          <Link
            href="/app"
            className="type-label text-[11px] uppercase tracking-wide text-[var(--brass)] underline-offset-2 hover:underline"
          >
            New trip
          </Link>
          <SignOutButton />
        </div>
      </header>

      {error ? <p className="type-body text-xs text-red-400" role="alert">{error}</p> : null}
      {trips === null && !error ? (
        <p className="type-label text-xs uppercase tracking-wide text-[var(--muted)]">Loading…</p>
      ) : null}
      {trips !== null && trips.length === 0 ? (
        <div className="surface flex flex-col items-start gap-3 rounded-xl p-6">
          <p className="type-body text-sm text-[var(--muted)]">
            No trips yet. Paste the Reels that inspired you and Astrail maps the route you actually take.
          </p>
          <Link
            href="/app"
            className="type-label rounded-lg border border-[var(--brass)] bg-[var(--brass-soft)] px-4 py-2 text-xs uppercase tracking-wide text-[var(--starlight)]"
          >
            Plan your first trip
          </Link>
        </div>
      ) : null}

      <ul className="flex flex-col gap-3">
        {(trips ?? []).map((trip) => (
          <li key={trip.id}>
            <Link
              href={`/app/trip/${trip.id}`}
              className="surface flex flex-col gap-1 rounded-xl p-4 transition-opacity hover:opacity-90"
            >
              <span className="type-body text-sm text-[var(--starlight)]">
                {trip.title ?? trip.destination_hint ?? 'Untitled trip'}
              </span>
              <span className="type-label text-[10px] uppercase tracking-wide text-[var(--faint)]">
                {trip.start_date ?? '—'} → {trip.end_date ?? '—'} · {trip.status}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  )
}
