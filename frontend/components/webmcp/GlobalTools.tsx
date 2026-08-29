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
import { TOKYO_TRIP as SAMPLE_TRIP } from '@/lib/trip/fixtures'

/**
 * The always-on tools, wired to real data.
 *
 * Readers are refs rather than captured values. `useWebMCP` registers a tool once and keeps its
 * execute callback stable — which is exactly what we want — so anything closed over BY VALUE at
 * registration would still be first-render data days later. Reading through a ref at call time
 * is what keeps `get_app_state` honest.
 */

/* The read-only sample trail. Imported statically, not lazily: `TripReader.current` is
   synchronous by contract (it is the zero-network path), so an awaited import would answer
   "Which trip?" for the first call on the page — the exact defect this fixes. */
const SAMPLE_TRIP_PATH = '/app/trip/demo'

/**
 * The tools that answer on the public sample trail with no session behind them.
 *
 * `/app/trip/demo` is the one /app route a visitor with no account can open — middleware
 * allowlists it by exact match, and redirects every other /app path to /sign-in. Everything else
 * registered here needs a JWT: `list_trips` and `list_saved_reels` read RLS-guarded rows, and
 * `save_reels`, `plan_trip_from_reels` and all five edit tools call `getAccessToken()`. Two more
 * do not throw but are no better — `get_app_state` and `get_trip_progress` both answer by naming
 * those same tools as the next step, which is the same defect one turn later.
 *
 * A NAMED set, so a tool added later is withheld here by default until someone shows it answers
 * without a session — the same direction as the `readOnlyHint` keying below, where an unmatched
 * name degrades to the stricter behaviour rather than the permissive one.
 *
 * The three map tools are absent from this list because they are not registered here: TripTools
 * mounts `show_on_map` / `set_map_mode` / `get_map_view` from the trip page, and they are pure
 * in-page state, so they already work signed-out. Five tools answer on that page; five is what it
 * offers.
 */
const PUBLIC_SAMPLE_STEPS: { label: string; tool: string }[] = [
  { label: 'read the whole trail, day by day', tool: 'get_itinerary' },
  { label: 'ask why a stop is on it — the verbatim caption quote and the Reel it came from', tool: 'get_place_evidence' },
  { label: 'fly the 3D map to a day, or to a single stop', tool: 'show_on_map' },
  { label: 'switch the map between the day route and the whole-trip view', tool: 'set_map_mode' },
  { label: 'read where the map is pointed right now', tool: 'get_map_view' },
]

/**
 * ONE list, feeding two things that must never disagree: which tools are OFFERED (the filter at
 * the bottom of this file) and which ones `get_app_state` RECOMMENDS. Two lists would drift, and
 * the drift lands as the exact failure this gate exists to remove — an agent told to call
 * something it was never given — only one turn later and through the orientation tool itself.
 *
 * `get_app_state` is offered but is not a STEP, because a tool does not recommend itself — it is
 * the one a lost visitor reaches for first, and it is what names the five below. `show_on_map`,
 * `set_map_mode` and `get_map_view` are steps but are registered by TripTools from the trip page,
 * so they fall out of this set harmlessly: they are pure in-page state and already work
 * signed-out. What must hold, and what a test pins across both components, is that everything
 * recommended is also offered.
 */
const PUBLIC_SAMPLE_TOOLS = new Set(['get_app_state', ...PUBLIC_SAMPLE_STEPS.map((step) => step.tool)])

/** Where the visitor is, said in terms that are true without an account. */
const PUBLIC_SAMPLE_LABEL =
  'the public sample trail — a finished Tokyo trip anyone can open, with no account and nothing spent'

/* `blocked` is documented as "anything that would make an obvious next step fail, so the agent
   doesn't try it", and this is the whole of what fails here. Without it the agent finds out by
   trying, in front of whoever is watching. */
const PUBLIC_SAMPLE_BLOCKED =
  'saving Reels, planning a trip and editing an itinerary all need an account — none of those tools are offered on this page'

/**
 * The public sample trail, seen without a session.
 *
 * Used TWICE on purpose — once to decide what is registered, once to decide what `get_app_state`
 * says about what is registered. One predicate means the offer and the description of the offer
 * cannot come to disagree.
 */
const isPublicSample = (path: string, hasSession: boolean | null): boolean =>
  path === SAMPLE_TRIP_PATH && hasSession !== true

/**
 * Whether this browser holds a session, asked through the SAME function the withheld tools call.
 *
 * Not `useUser()`: that answers a different question ("is there a user row"), over the network,
 * and a gate that asks a different question than the tools do is a gate that drifts away from
 * them. Not a hand-derived Supabase storage key either, for the same reason. `getAccessToken()`
 * throwing is precisely the condition under which `save_reels`, `plan_trip_from_reels` and the
 * five edit tools throw, so one rule covers the gate and the tools together.
 *
 * `null` means UNKNOWN and is never collapsed into `false` — the caller treats the two
 * differently on purpose. Re-read on navigation, and deliberately never reset to `null` while
 * re-reading: a visitor who signs in from the sample trail and comes back to it must not still be
 * looking at the signed-out list, and a route change must not make the list shrink and grow again.
 */
function useHasSession(pathname: string): boolean | null {
  const [hasSession, setHasSession] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    getAccessToken()
      .then(() => { if (live) setHasSession(true) })
      .catch(() => { if (live) setHasSession(false) })
    return () => { live = false }
  }, [pathname])
  return hasSession
}

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
  const hasSession = useHasSession(pathname)
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
  // Read at CALL time, never captured: `readAppState` is registered once and must answer about
  // the session the browser holds now, not the one it held when the tool was registered.
  const sessionRef = useRef(hasSession)
  sessionRef.current = hasSession
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

    /* A visitor with no account, on the one page they can reach. Answering them in terms of an
       account would reproduce this tool's founding defect on the free path: it exists because
       real users could not tell what to do here, and "an unknown number of saved reels · plan a
       trip → plan_trip_from_reels" is worse than useless to someone who has neither. The counts
       are not unknown, they are inapplicable — hence `signed_out` rather than a row of nulls,
       which would print the could-not-load note over a read that never happened. */
    if (isPublicSample(path, sessionRef.current)) {
      return {
        account: 'signed_out',
        where: PUBLIC_SAMPLE_LABEL,
        nextSteps: [...PUBLIC_SAMPLE_STEPS],
        blocked: [PUBLIC_SAMPLE_BLOCKED],
      }
    }

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
      account: 'signed_in',
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

  /**
   * The same reader, plus the sample trail — for READS only.
   *
   * `/app/trip/demo` renders a fixture with no database row behind it, so TripTools withholds it
   * from `registry.openTrip` (see the note there). That ref is `resolveBundle`'s default target,
   * and all five edit tools resolve through it, so withholding disarmed the writes — correctly —
   * and took `get_itinerary` and `get_place_evidence` with it. Three of the five tools a trip page
   * offers answered on the flagship demo; the other two said "Which trip?" while the trip was on
   * screen in front of the judge.
   *
   * A SECOND READER rather than a registration flag, deliberately. `enabled` is evaluated at
   * render and applied in an effect, so a route change opens a window where the flag and the
   * route disagree; a reader that cannot return the sample cannot be caught out by timing. The
   * fallback is scoped to the route showing it — anywhere else, the sample is not "the open
   * trip" and answering with it would be a trip the user does not own.
   */
  const sampleReader = useMemo(
    () => ({
      ...tripReader,
      current: () =>
        tripReader.current() ?? (pathRef.current === SAMPLE_TRIP_PATH ? SAMPLE_TRIP : null),
    }),
    [tripReader],
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

  /* Built twice from one context, so the two readers cannot drift apart: everything is assembled
     against the write-safe reader, then the READ-ONLY tools are swapped for the copies that can
     see the sample. Keyed on `readOnlyHint`, not on a list of names — a write tool added later is
     sample-blind by default, and an unmatched name degrades to the strict spec rather than the
     permissive one. `save_reels` and `plan_trip_from_reels` are writes that never touch `trips`,
     so the strict reader costs them nothing. */
  const deps = { readAppState, saveReel, analyzeReels, loadSavedReels, generation, edit }
  const sampleAware = new Map(
    globalTools({ ...deps, trips: sampleReader })
      .filter((s) => s.annotations?.readOnlyHint === true)
      .map((s) => [s.name, s]),
  )
  const specs = globalTools({ ...deps, trips: tripReader })
    .map((s) => sampleAware.get(s.name) ?? s)

  /* PRESENCE, gated on route AND session — never on content.
     The readers above decide what a tool may ANSWER, at call time, and nothing here touches them:
     the write tools still resolve through `tripReader`, which cannot return the sample at all,
     whatever this gate does and whenever its effect ran. This only decides what is OFFERED.

     ROUTE first, because it is the only half known synchronously — `usePathname()` is right on the
     first render, the session read is not. The sample trail is the only /app route reachable
     without an account, so it is the only place an honest list differs from the full one; gating
     everywhere else would churn every signed-in user's list on every page load to cover a state
     middleware makes unreachable.

     SESSION second, because it is the truthful reason: a signed-in user who wanders onto the
     sample trail holds a JWT, and all thirteen work for them there.

     Unknown fails SMALL (`!== true`, not `=== false`), so the list only ever GROWS: a signed-in
     visitor to this route sees two, then thirteen. The other direction would show a judge sixteen
     tools and then take eleven away, advertising failures during exactly the window a freshly
     loaded agent reads the list. An under-advertised tool costs a question; an over-advertised one
     costs a failed call the agent was invited to make. */
  const offered = isPublicSample(pathname, hasSession)
    ? specs.filter((s) => PUBLIC_SAMPLE_TOOLS.has(s.name))
    : specs

  return <RegisterTools specs={offered} />
}
