'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import type { Trip, TripBundle } from '@/lib/trip/backend-types'
import { getTrip, listTrips } from '@/lib/trip/supabase-api'
import { addTripPlace, deleteTripPlace, editTripDates, editTripPlace, generateTrip, streamGeneration } from '@/lib/trip/api'
import { createGenerationStore } from '@/lib/webmcp/generation'
import { captureSavedReel, listSavedReelCards } from '@/lib/reels/api'
import { getAccessToken } from '@/lib/supabase/session'
import { globalTools } from '@/lib/webmcp/tools'
import type { AppStateSnapshot } from '@/lib/webmcp/tools/app-state'
import { RegisterTools } from './RegisterTools'
import { useWebMcpRegistry } from './WebMcpRegistry'

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
  const { requestConfirm, openTrip, refreshOpenTrip } = useWebMcpRegistry()
  // One store for the session. It must outlive any single tool call — the stream runs for
  // 60-180s while `plan_trip_from_reels` returns in about a second.
  const storeRef = useRef(createGenerationStore())
  // `null` = not loaded (or failed). Never collapse that to an empty array: an empty array
  // renders as a confident "you have none", which is a different claim entirely.
  const [trips, setTrips] = useState<Trip[] | null>(null)
  const [reels, setReels] = useState<{ count: number; places: number } | null>(null)

  const pathRef = useRef(pathname)
  pathRef.current = pathname
  const tripsRef = useRef(trips)
  tripsRef.current = trips
  const reelsRef = useRef(reels)
  reelsRef.current = reels

  useEffect(() => {
    let live = true
    listTrips()
      .then((t) => { if (live) setTrips(t) })
      .catch(() => { if (live) setTrips(null) })
    listSavedReelCards()
      .then((cards) => {
        if (!live) return
        // Distinct places across reels — the same spot appearing in three reels is one place.
        const distinct = new Set(cards.flatMap((c) => c.places.map((p) => p.name.toLowerCase())))
        setReels({ count: cards.length, places: distinct.size })
      })
      .catch(() => { if (live) setReels(null) })
    return () => { live = false }
  }, [pathname])

  const readAppState = useCallback((): AppStateSnapshot => {
    const all = tripsRef.current
    const savedReels = reelsRef.current
    const path = pathRef.current

    const complete =
      all === null ? null : all.filter((t) => t.status === 'complete' || t.status === 'saved_with_gaps').length

    const nextSteps: AppStateSnapshot['nextSteps'] = []
    if (complete !== null && complete > 0) {
      nextSteps.push({ label: 'open a finished trip and edit it', tool: 'list_trips' })
    }
    nextSteps.push({ label: 'plan a new trip from saved Instagram Reels', tool: 'plan_trip_from_reels', needs: 'dates' })
    nextSteps.push({ label: 'save more Instagram Reels', tool: 'save_reels' })
    if (!path.startsWith('/app/trip/')) {
      nextSteps.push({ label: 'see what is on the map for a trip', tool: 'get_itinerary', needs: 'a trip open' })
    }

    // Only claim something is blocked when we actually KNOW it is. An unknown count blocks nothing.
    const blocked: string[] = []
    if (all !== null && all.length === 0 && savedReels !== null && savedReels.count === 0) {
      blocked.push('nothing saved yet — start by saving a Reel')
    }

    return {
      where: labelFor(path),
      savedReels: savedReels?.count ?? null,
      verifiedPlaces: savedReels?.places ?? null,
      trips: all === null || complete === null
        ? null
        : { total: all.length, complete, unfinished: all.length - complete },
      nextSteps,
      blocked,
    }
  }, [])

  const tripReader = useMemo(
    () => ({
      // Use the trip on screen when there is one. Without this, asking "what's on day 2" while
      // looking at a trip answered "Which trip?" — technically correct, obviously wrong.
      current: () => (openTrip.current as TripBundle | null) ?? null,
      list: async () => {
        const fresh = await listTrips()
        setTrips(fresh)
        return fresh
      },
      load: (tripId: string) => getTrip(tripId),
    }),
    [],
  )

  const refreshReels = useCallback(async () => {
    try {
      const cards = await listSavedReelCards()
      const distinct = new Set(cards.flatMap((c) => c.places.map((p) => p.name.toLowerCase())))
      setReels({ count: cards.length, places: distinct.size })
    } catch {
      setReels(null)
    }
  }, [])

  // The JWT is fetched at call time and never crosses the tool boundary in either direction:
  // no tool accepts a token argument, and none returns one.
  const saveReel = useCallback(async (url: string) => {
    const token = await getAccessToken()
    const res = await captureSavedReel(url, token)
    // Keep get_app_state honest immediately after a save, rather than until the next navigation.
    void refreshReels()
    return res
  }, [refreshReels])

  const generation = useMemo(
    () => ({
      store: storeRef.current,
      create: async (req: Parameters<typeof generateTrip>[0]) => {
        const token = await getAccessToken()
        const res = await generateTrip(req, token)
        return res.trip_id
      },
      openStream: (tripId: string) => {
        // Fire-and-forget by design: the stream must survive the tool call returning, and the
        // job is durable server-side, so a dropped stream never loses the trip.
        void (async () => {
          const token = await getAccessToken()
          storeRef.current.start(tripId, (onEvent, onFail) =>
            streamGeneration(tripId, token, onEvent, undefined, onFail),
          )
        })()
      },
      confirm: requestConfirm,
    }),
    [requestConfirm],
  )

  const edit = useMemo(
    () => ({
      add: async (tripId: string, body: Parameters<typeof addTripPlace>[1]) =>
        addTripPlace(tripId, body, await getAccessToken()),
      setDates: async (tripId: string, body: Parameters<typeof editTripDates>[1]) =>
        editTripDates(tripId, body, await getAccessToken()),
      move: async (tripId: string, tpId: string, patch: { day_number?: number; sort_order?: number }) =>
        editTripPlace(tripId, tpId, patch, await getAccessToken()),
      remove: async (tripId: string, tpId: string) =>
        deleteTripPlace(tripId, tpId, await getAccessToken()),
      // The shell has no open bundle, so a refresh is a re-read. TripWorkspace will supply its
      // own in-memory refresh when the map tools land, avoiding this round-trip on the trip page.
      // Prefer the open page's own refresher: it writes the result into the rendered state.
      // A bare getTrip() here pulls fresh rows and drops them, which is why every agent edit
      // used to need a manual reload before it showed up.
      refresh: async (tripId: string) => {
        const pageRefresh = refreshOpenTrip.current
        if (pageRefresh) return pageRefresh()
        return getTrip(tripId)
      },
      confirm: requestConfirm,
    }),
    [requestConfirm],
  )

  const loadSavedReels = useCallback(async () => {
    const cards = await listSavedReelCards()
    return cards.map((c) => ({
      url: c.normalized_url,
      caption: c.caption,
      status: c.analysis_status,
      places: c.places.map((p) => ({ name: p.name, country: p.country_name })),
    }))
  }, [])

  const specs = globalTools({ readAppState, trips: tripReader, saveReel, loadSavedReels, generation, edit })

  return <RegisterTools specs={specs} />
}
