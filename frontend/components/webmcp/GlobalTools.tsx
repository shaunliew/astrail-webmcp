'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import type { Trip, TripBundle } from '@/lib/trip/backend-types'
import { getTrip, listTrips } from '@/lib/trip/supabase-api'
import { addTripPlace, deleteTripPlace, editTripDates, editTripPlace, generateTrip, replanTrip } from '@/lib/trip/api'
import { captureSavedReel, listSavedReelCards, startOrganize } from '@/lib/reels/api'
import { getAccessToken } from '@/lib/supabase/session'
import { TRIAL_LIFETIME_LIMIT, readEntitlement } from '@/lib/entitlement'
import { globalTools } from '@/lib/webmcp/tools'
import type { AppStateSnapshot } from '@/lib/webmcp/tools/app-state'
import type { TripAllowance } from '@/lib/webmcp/tools/generation'
import { RegisterTools } from './RegisterTools'
import { useWebMcpRegistry } from './WebMcpRegistry'
import { useGeneration, type RunReservation } from '@/components/generation/GenerationProvider'

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
  // A capability, not an inventory. "Saved Reels — where trips start" read as a shelf, and the
  // agent answered in kind: it described the page instead of offering to use it.
  [/^\/app\/?$/, 'Saved Reels — plan a trip here, or save Reels to plan from later'],
]

function labelFor(pathname: string): string {
  return ROUTE_LABEL.find(([re]) => re.test(pathname))?.[1] ?? 'Astrail'
}

export default function GlobalTools() {
  const pathname = usePathname() ?? '/app'
  const { requestConfirm, openTrip, refreshOpenTrip, refreshSavedReels, adoptOrganizeJob } = useWebMcpRegistry()
  // The run belongs to the shell, not to this component. It must outlive any single tool call
  // (the stream runs 60-180s while `plan_trip_from_reels` returns in about a second) AND outlive
  // whichever page happens to be mounted, so the page can render the same run the agent narrates.
  const shell = useGeneration()
  // `null` = not loaded (or failed). Never collapse that to an empty array: an empty array
  // renders as a confident "you have none", which is a different claim entirely.
  const [trips, setTrips] = useState<Trip[] | null>(null)
  const [reels, setReels] = useState<{ count: number; places: number } | null>(null)
  // `create` and `openStream` are two deps of one tool call — the tool creates the job, then
  // hands the id back for streaming — so the reservation taken by the first has to reach the
  // second. A ref, because nothing renders from it and a re-render must not drop it.
  const reservationRef = useRef<RunReservation | null>(null)

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
    // Saved reels are one SOURCE of links, never a precondition: the tool takes raw pasted URLs
    // and the backend does no ownership check on `reel_urls`. Saying "from saved Reels" sent the
    // agent to the save form on an empty account instead of asking for links it could plan from.
    nextSteps.push({
      label: 'plan a trip from Instagram Reel links — saving them first is optional',
      tool: 'plan_trip_from_reels',
      needs: '1-5 reel links and dates, YYYY-MM-DD',
    })
    // "save more" is a claim about the library, and it is false on an empty account — the same
    // class of defect as the blocker below. This names the ACTION and what it is for, which is
    // true whether the user has nothing saved or fifty.
    nextSteps.push({ label: 'save Instagram Reels to plan from later', tool: 'save_reels' })
    if (!path.startsWith('/app/trip/')) {
      nextSteps.push({ label: 'see what is on the map for a trip', tool: 'get_itinerary', needs: 'a trip open' })
    }

    // Only claim something is blocked when we actually KNOW it is. An unknown count blocks
    // nothing — and neither does an empty library. That last one was here, and it was wrong:
    // `plan_trip_from_reels` requires reel_urls + dates, accepts raw pasted links, and the
    // backend runs no ownership check on them. An account with nothing saved can still plan,
    // so the empty case belongs in the counts above ("0 saved reels"), not here. Anything added
    // to this list must be a step that would genuinely FAIL if the agent tried it.
    const blocked: string[] = []

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
    // ...and the Saved Reels list too, if the user is looking at it. Its cards live in that
    // page's own state, so without this the reel is in the database and nowhere on screen.
    void refreshSavedReels.current?.()
    return res.saved_reel
  }, [refreshReels, refreshSavedReels])

  /* Saving through the TOOL used to stop here, while saving through the app's own form
     (SavedReelsFlow) went on to call startOrganize — so a reel added by the agent stayed
     `not_analyzed` forever and had no places to plan from. Same second half, same endpoint. */
  const analyzeReels = useCallback(async (savedReelIds: string[]) => {
    const token = await getAccessToken()
    const res = await startOrganize(savedReelIds, token)
    void refreshReels()
    // Show the new reels straight away...
    void refreshSavedReels.current?.()
    // ...and hand the page the job so it can follow it. Progress is DERIVED from the job rather
    // than written into saved_reels: a status persisted there has no owner, so a job that fails
    // between its steps would strand a reel reading "Analyzing…" forever, and an idempotent retry
    // would drag a reel that is genuinely processing back to "queued".
    adoptOrganizeJob.current?.(res.job_id)
    return res
  }, [refreshReels, refreshSavedReels, adoptOrganizeJob])

  // Declared above `generation` because the approval card reads it too: plan_trip_from_reels
  // reports how many of the chosen reels are already read before the user approves the spend.
  const loadSavedReels = useCallback(async () => {
    const cards = await listSavedReelCards()
    return cards.map((c) => ({
      url: c.normalized_url,
      caption: c.caption,
      status: c.analysis_status,
      hasCurrentCache: c.has_current_cache,
      places: c.places.map((p) => ({ name: p.name, country: p.country_name })),
    }))
  }, [])

  /**
   * Whether this account can still spend a generation — the same fact the manual flow gates on,
   * asked at CALL time rather than at mount.
   *
   * The plain own-row read, not `useEntitlement`. The hook loads once on mount and only the
   * flows call its `refetch`, so a value cached here would go stale in the direction that costs
   * the user something: `complete_trip_run` refunds `lifetime_trip_count` when a run fails, and
   * a cached "exhausted" would then refuse a trip the backend would have allowed. (It also drags
   * in a second listTrips() for a canonical-trip link no tool uses.)
   *
   * Fail-OPEN, deliberately: a read that throws resolves to `unknown`, which proceeds. A refusal
   * we cannot substantiate is worse than one the backend delivers a beat later — and the backend
   * check is still there, so this only ever avoids asking for consent we cannot honour.
   */
  const readAllowance = useCallback(async (): Promise<TripAllowance> => {
    try {
      const { plan, lifetimeTripCount } = await readEntitlement()
      // Keyed on the PLAN, not on the raw count: a beta seat is on the daily quota, which lives
      // in user_daily_usage and the browser never reads. Refusing a seat holder on a lifetime
      // count would be a guess, and the backend names that limit itself when it refuses.
      return plan === 'trial' && lifetimeTripCount >= TRIAL_LIFETIME_LIMIT ? 'trial_exhausted' : 'ok'
    } catch {
      return 'unknown'
    }
  }, [])

  const generation = useMemo(
    () => ({
      store: shell.store,
      create: async (req: Parameters<typeof generateTrip>[0]) => {
        /* The lock is TAKEN here, not merely read. `canStart()` answered a question and left the
           lock free across the token fetch and the POST below, so a manual click and an agent
           approval could both pass it and both create a real backend job — two lots of Apify and
           OpenAI credit, neither stopping the other, and `get_trip_progress` unable to recover
           the abandoned one. The tool description says "never call this twice"; this is what
           actually enforces it. */
        const reservation = shell.reserve()
        if (!reservation) {
          throw new Error('A trip is already being built. Wait for it to finish, then try again.')
        }
        reservationRef.current = reservation
        try {
          const token = await getAccessToken()
          const res = await generateTrip(req, token)
          return res.trip_id
        } catch (err) {
          // No backend job exists, so the lock goes back immediately. Holding it would block
          // every later generation — the agent's and the user's — for the rest of the session.
          reservationRef.current = null
          reservation.release()
          throw err
        }
      },
      openStream: (tripId: string) => {
        // Commits the reservation `create` took: the shell opens the one stream, keeps the event
        // history the wait screen renders from, and navigates when it finishes. Returns
        // immediately — the tool must resolve in about a second and must never await the stream.
        const reservation = reservationRef.current
        reservationRef.current = null
        // No reservation means no lock is held by this call, and starting a stream anyway is
        // exactly the second unowned run the reservation exists to prevent. `begin` applies the
        // same rule to a reservation that expired while the POST above was in flight: it reports
        // the job as orphaned rather than opening a stream on a lock it no longer holds.
        reservation?.begin(tripId)
      },
      confirm: requestConfirm,
      readLibrary: loadSavedReels,
      readAllowance,
    }),
    [requestConfirm, loadSavedReels, readAllowance, shell],
  )

  const edit = useMemo(
    () => ({
      add: async (tripId: string, body: Parameters<typeof addTripPlace>[1]) =>
        addTripPlace(tripId, body, await getAccessToken()),
      setDates: async (tripId: string, body: Parameters<typeof editTripDates>[1]) =>
        editTripDates(tripId, body, await getAccessToken()),
      replan: async (tripId: string) => replanTrip(tripId, await getAccessToken()),
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

  const specs = globalTools({ readAppState, trips: tripReader, saveReel, analyzeReels, loadSavedReels, generation, edit })

  return <RegisterTools specs={specs} />
}
