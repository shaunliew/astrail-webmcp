'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import type { Trip } from '@/lib/trip/backend-types'
import { listTrips } from '@/lib/trip/supabase-api'
import { globalTools } from '@/lib/webmcp/tools'
import type { AppStateSnapshot } from '@/lib/webmcp/tools/app-state'
import { RegisterTools } from './RegisterTools'

/**
 * The always-on tools, wired to real data.
 *
 * Readers are refs rather than captured values. `useWebMCP` registers a tool once and keeps its
 * execute callback stable — which is exactly what we want — so anything closed over BY VALUE at
 * registration would still be first-render data days later. Reading through a ref at call time
 * is what keeps `get_app_state` honest.
 */

const ROUTE_LABEL: [RegExp, string][] = [
  [/^\/app\/trip\//, 'a trip you have already planned'],
  [/^\/app\/trips/, 'your saved trips'],
  [/^\/app\/settings/, 'settings'],
  [/^\/app\/onboarding/, 'onboarding'],
  [/^\/app\/?$/, 'Saved Reels — where trips start'],
]

function labelFor(pathname: string): string {
  return ROUTE_LABEL.find(([re]) => re.test(pathname))?.[1] ?? 'Astrail'
}

export default function GlobalTools() {
  const pathname = usePathname() ?? '/app'
  const [trips, setTrips] = useState<Trip[]>([])

  const pathRef = useRef(pathname)
  pathRef.current = pathname
  const tripsRef = useRef(trips)
  tripsRef.current = trips

  useEffect(() => {
    let live = true
    listTrips()
      .then((t) => { if (live) setTrips(t) })
      .catch(() => { /* not signed in, or offline: tools still register and say so */ })
    return () => { live = false }
  }, [pathname])

  const readAppState = useCallback((): AppStateSnapshot => {
    const all = tripsRef.current
    const complete = all.filter((t) => t.status === 'complete' || t.status === 'saved_with_gaps').length
    const path = pathRef.current

    const nextSteps: AppStateSnapshot['nextSteps'] = []
    if (complete > 0) nextSteps.push({ label: 'open a finished trip and edit it', tool: 'list_trips' })
    nextSteps.push({ label: 'plan a new trip from saved Instagram Reels', tool: 'plan_trip_from_reels', needs: 'dates' })
    if (!path.startsWith('/app/trip/')) {
      nextSteps.push({ label: 'see what is on the map for a trip', tool: 'get_itinerary', needs: 'a trip open' })
    }

    const blocked: string[] = []
    if (all.length === 0) blocked.push('no trips yet — save some Reels first')

    return {
      where: labelFor(path),
      savedReels: 0,
      verifiedPlaces: 0,
      trips: { total: all.length, complete, unfinished: all.length - complete },
      nextSteps,
      blocked,
    }
  }, [])

  const loadTrips = useCallback(async () => {
    const fresh = await listTrips()
    setTrips(fresh)
    return fresh
  }, [])

  const specs = globalTools({
    readAppState,
    loadTrips,
    readBundle: () => null, // trip tools register on the trip page, not here
  })

  return <RegisterTools specs={specs} />
}
