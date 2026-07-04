'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { listTrips } from '@/lib/trip/mock-api'
import type { Trip } from '@/lib/trip/backend-types'
import TripCard from './TripCard'

export default function TripsList() {
  const [trips, setTrips] = useState<Trip[] | null>(null)
  const activeRef = useRef(true)

  useEffect(() => {
    activeRef.current = true
    listTrips().then((t) => { if (activeRef.current) setTrips(t) })
    return () => { activeRef.current = false }
  }, [])

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-4xl flex-col gap-6 bg-[var(--void)] p-6">
      <header className="flex items-center justify-between">
        <h1 className="type-display text-3xl text-[var(--starlight)]">Your trips</h1>
        <Link
          href="/app"
          className="type-label rounded-lg border border-[var(--brass)] bg-[var(--brass-soft)] px-3 py-2 text-xs uppercase tracking-wide text-[var(--starlight)]"
        >
          New trip
        </Link>
      </header>

      {trips === null ? (
        <p className="type-body text-sm text-[var(--muted)]">Loading your trips…</p>
      ) : trips.length === 0 ? (
        <div className="surface flex flex-col items-start gap-3 rounded-xl p-6">
          <p className="type-body text-sm text-[var(--muted)]">No trips yet. Paste a few Reels to plan your first one.</p>
          <Link href="/app" className="type-label text-xs uppercase tracking-wide text-[var(--brass)]">Start a trip →</Link>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {trips.map((t) => (
            <li key={t.id}><TripCard trip={t} /></li>
          ))}
        </ul>
      )}
    </main>
  )
}
