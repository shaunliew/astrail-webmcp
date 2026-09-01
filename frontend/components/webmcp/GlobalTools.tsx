'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import type { Trip, TripBundle, TripStatus } from '@/lib/trip/backend-types'
import { getTrip, listTrips, getMemoryPreferences } from '@/lib/trip/supabase-api'
import {
  addTripPlace, deleteTripPlace, editTripDates, editTripPlace, generateTrip, replanTrip,
  type ReplanTripResult,
} from '@/lib/trip/api'
import { ActiveOrganizeConflictError, captureSavedReel, listSavedReelCards, startOrganize } from '@/lib/reels/api'
import {
  ORGANIZE_CONFLICT_MESSAGE, ORGANIZE_FAILED_MESSAGE, clearOrganizeFailureFor,
  recordOrganizeFailure, trackOrganizeJob,
} from '@/lib/reels/organize-jobs'
import { getAccessToken } from '@/lib/supabase/session'
import { TRIAL_LIFETIME_LIMIT, readEntitlement } from '@/lib/entitlement'
import { globalTools } from '@/lib/webmcp/tools'
import { AGENT_VIEW_ROUTE, requestViewIntent, type ViewReason } from '@/lib/webmcp/view-intent'
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
 * `save_reels`, `plan_trip_from_reels` and all five edit tools call `getAccessToken()`.
 * `get_trip_progress` does not throw but is no better: with no run in this browser it answers by
 * pointing at `plan_trip_from_reels`, which is the same defect one turn later. `get_app_state` was
 * withheld for that reason too until it gained a signed-out variant that recommends only what is
 * actually offered here — it is now the one tool a lost visitor reaches for first.
 *
 * A NAMED set, so a tool added later is withheld here by default until someone shows it answers
 * without a session — the same direction as the `readOnlyHint` keying below, where an unmatched
 * name degrades to the stricter behaviour rather than the permissive one.
 *
 * The three map tools are absent from this list because they are not registered here: TripTools
 * mounts `show_on_map` / `set_map_mode` / `get_map_view` from the trip page, and they are pure
 * in-page state, so they already work signed-out. Six tools answer on that page and six is what it
 * offers — the three above, plus the three registered here.
 */
const PUBLIC_SAMPLE_STEPS: { label: string; tool: string }[] = [
  { label: 'read the whole trail, day by day', tool: 'get_itinerary' },
  { label: 'ask why a stop is on it — the verbatim caption quote and the Reel it came from', tool: 'get_place_evidence' },
  { label: 'fly the 3D map to a day, or to a single stop', tool: 'show_on_map' },
  { label: 'switch the map between the day route and the hotel hub view', tool: 'set_map_mode' },
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

/**
 * The sample trail, described to someone who DOES have an account.
 *
 * `ROUTE_LABEL` below matches this page with `/^\/app\/trip\//` and calls it "a trip you have
 * already planned", which is false twice over here: this visitor did not plan it and nobody did.
 * On the one page whose whole purpose is demonstrating that Astrail does not invent things, the
 * orientation tool claiming the visitor planned a trip that no one planned is the wrong sentence
 * to ship.
 *
 * Deliberately NOT the signed-out wording. That one tells the agent to say nothing about this
 * person's own reels and trips, which is right when there is no account and wrong here: all
 * fourteen tools are registered for this reader and every one of them works on their own library.
 * The correction has to land on the trip without overshooting onto the account.
 *
 * The last clause is here rather than in `blocked` on purpose. The five edit tools refuse the
 * fixture at the reader — correctly — but the refusal reads as a malfunction to an agent looking
 * straight at the trip: "Which trip?" about a trip plainly on screen. Naming the constraint up
 * front turns a confusing failure into a known one.
 */
const SIGNED_IN_SAMPLE_LABEL =
  'the public sample trail — an example trip, not one of yours. Your own Reels and trips are untouched and every tool still works on them.'

/* The consequence, kept OUT of the label. `blocked` is documented as "anything that would make an
   obvious next step fail, so the agent doesn't try it", which is this sentence exactly — and
   keeping `where` about identity and `blocked` about consequences is what stops the two drifting
   into each other now that the trip label below carries status. Worth saying at all because the
   refusal reads as a malfunction otherwise: the edit tools answer "Which trip?" about a trip
   plainly on screen. */
const SAMPLE_NOT_EDITABLE =
  'editing this trip will be refused — it is an example that nobody owns, so there is nothing to change'

const TRIP_PATH_PREFIX = '/app/trip/'

/**
 * How long to wait before each retry of the post-run organize, and therefore how many attempts.
 *
 * Two retries, because the alternative is that one dropped connection permanently costs the user
 * the places for the reels they just planned from, with nothing said. Bounded and short because
 * the thing being retried is a job CREATION — a plain insert behind an already-finished trip — and
 * because a request that keeps failing on this ladder is not transient. A 409 is not on this
 * ladder at all: it is the server-side fence working, and every retry earns the same answer.
 */
export const ORGANIZE_RETRY_DELAYS_MS = [400, 1_200]

/**
 * Runs that can be owed an organize at once.
 *
 * One record per run, and each is removed as soon as a job exists for its reels — so this only
 * ever holds runs that failed (inert: a record is organized only once it has LANDED) and the one
 * or two still finishing their captures. Bounded anyway, because a record nothing ever retires
 * would otherwise accumulate for the life of the tab.
 */
const MAX_PLANNED_RUNS = 4

/** The reels ONE run planned from, and the identity that says which run that was. */
type PlannedReels = {
  /**
   * Increments per run. The trip id would nearly do, but "nearly" is what finding 4 was: this is
   * compared across an awaited capture, and it must be impossible for a second run to look like
   * the first — including the case where a retried create hands back the same trip id.
   */
  token: number
  tripId: string
  savedReelIds: string[]
  /**
   * This run reached `complete`, and is owed an organize as soon as its captures are in.
   *
   * Remembered HERE rather than re-read from the store, which is the whole of the two-run fix.
   * The store holds one run: the moment the next generation begins it replaces the snapshot
   * wholesale, so a run whose captures are still in flight when that happens can never be
   * confirmed complete again — and its reels were silently abandoned. A verdict this component
   * has already seen is a fact about the run, not a question to re-ask the store later.
   */
  landed: boolean
  /**
   * Captures for this run that have started and not yet settled.
   *
   * The terminal frame is the ONLY thing that triggers the organize, and the captures are started
   * after the stream opens and awaited separately (see the tool's ordering), so nothing sequences
   * the two. A run that landed first found an empty record, returned, and was never asked again —
   * every reel unorganized; a run that landed mid-batch organized a subset and threw the late ids
   * away. Counting them means the last capture to settle is what fires, whichever way the race
   * goes. Held on the record so a previous run's stragglers cannot hold up the next run.
   */
  pending: number
  /**
   * An organize request for these reels is in flight.
   *
   * On the RECORD rather than on the component, and that is the whole of the difference: a flag
   * shared by every run would let one run's slow request fence the NEXT run's organize out
   * entirely, and nothing would ever notify again to lift it. Each record fences only itself.
   */
  attempting: boolean
}

const wait = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

/**
 * What the trip route is actually showing, per status.
 *
 * One label for all six was wrong in two directions. That route renders whatever the id resolves
 * to — the page applies no status filter — so "a trip you have already planned" is premature on a
 * `generating` trip and false on a `failed` one. It also had teeth: the label invited the agent to
 * offer an edit, and `_require_trip_editable_state` (backend/main.py:587) admits only `complete`
 * and `saved_with_gaps`, so the agent walked into a refusal the label talked it into.
 *
 * `complete` keeps the exact original wording, so the common case reads as it always did.
 */
const TRIP_STATUS_LABEL: Record<TripStatus, string> = {
  draft: 'one of your trips, still a draft — nothing has been planned for it yet',
  generating: 'one of your trips, still being built right now',
  places_ready: 'one of your trips, still being built — its places are in, the rest is not',
  complete: 'a trip you have already planned',
  saved_with_gaps: 'a trip you have already planned, saved with some parts missing',
  failed: 'one of your trips whose planning failed',
}

/** The status could not be established. Say the one thing true of all six rather than guess. */
const TRIP_LABEL_UNKNOWN_STATUS = 'one of your trips'

/** Mirrors `_require_trip_editable_state` (backend/main.py:587). Anything else is refused there. */
const EDITABLE_TRIP_STATUS = new Set<TripStatus>(['complete', 'saved_with_gaps'])

const TRIP_NOT_EDITABLE =
  'editing this trip will be refused — only a finished trip can be edited, and this one is not'

const ROUTE_LABEL: [RegExp, string][] = [
  [/^\/app\/trips/, 'your saved trips'],
  [/^\/app\/settings/, 'settings'],
  [/^\/app\/onboarding/, 'onboarding'],
  // A capability, not an inventory. "Saved Reels — where trips start" read as a shelf, and the
  // agent answered in kind: it described the page instead of offering to use it.
  [/^\/app\/?$/, 'Saved Reels — plan a trip here, or save Reels to plan from later'],
]

function labelFor(pathname: string, tripStatus: TripStatus | null): string {
  /* Ahead of the table, and by EXACT match against the same constant the registration gate and
     the middleware allowlist use. Not a sixth regex row: a row would have to sit above the
     `/^\/app\/trip\//` rule to win, so reordering the table would silently restore the false
     label — and a prefix match would hand "not one of yours" to a real trip the user does own,
     the same mistake middleware:39 calls out about the route itself. */
  if (pathname === SAMPLE_TRIP_PATH) return SIGNED_IN_SAMPLE_LABEL
  if (pathname.startsWith(TRIP_PATH_PREFIX)) {
    return tripStatus === null ? TRIP_LABEL_UNKNOWN_STATUS : TRIP_STATUS_LABEL[tripStatus]
  }
  return ROUTE_LABEL.find(([re]) => re.test(pathname))?.[1] ?? 'Astrail'
}

export default function GlobalTools() {
  const pathname = usePathname() ?? '/app'
  const router = useRouter()
  const hasSession = useHasSession(pathname)
  const { requestConfirm, openTrip, refreshOpenTrip, refreshSavedReels, beginActivity, endActivity } =
    useWebMcpRegistry()
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
  /* The reels each run planned from, held until that run's organize has actually been accepted.
     A LIST, not a slot. A single slot meant `create` destroyed the previous run's obligation, so a
     run whose captures were still in flight when the user planned again lost its reels entirely —
     the same class as the cross-run contamination the token fixed, except the token protects the
     WRITE and the slot was the thing being overwritten. Runs are concurrent here even though only
     one can be GENERATING: the lock comes back the moment a run goes terminal, and its captures
     may outlive it.
     A ref rather than state: nothing renders from it, and a re-render must not drop it — it has to
     survive the 60-180s the pipeline takes. GlobalTools is mounted by the /app layout, so it
     survives the terminal navigation too. */
  const plannedReelsRef = useRef<PlannedReels[]>([])
  /* Hands out the token above. A counter rather than a timestamp: two runs in the same
     millisecond are not distinguishable by the clock, and nothing here needs a time. */
  const runTokenRef = useRef(0)

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

    /* The status of the trip on screen, or `null` when we cannot establish it.
       Two sources, both already in hand — no network read and no new dependency. The open bundle
       FIRST because it is live: TripTools republishes it as the trip changes, so a run that
       finishes while the user watches is reflected. The listTrips rows SECOND because that bundle
       is null for the first moments of a trip page, which is exactly when `get_app_state` gets
       called. Both are keyed on the id in the PATH, so a bundle left over from the trip the user
       was looking at a moment ago cannot be reported as this one's — the same silent-wrong answer
       `get_trip_progress` guards against when it checks which run it is being asked about. */
    const tripId = path.startsWith(TRIP_PATH_PREFIX) ? path.slice(TRIP_PATH_PREFIX.length).toLowerCase() : null
    const openBundle = openTrip.current as TripBundle | null
    const tripStatus: TripStatus | null =
      tripId === null
        ? null
        : openBundle?.trip.id.toLowerCase() === tripId
          ? openBundle.trip.status
          : all?.find((t) => t.id.toLowerCase() === tripId)?.status ?? null

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
    if (!path.startsWith(TRIP_PATH_PREFIX)) {
      nextSteps.push({ label: 'see what is on the map for a trip', tool: 'get_itinerary', needs: 'a trip open' })
    }
    /* The point of knowing the status rather than merely not lying about it: a trip that is still
       being built has an obvious next move, and it is the tool written for exactly that wait. */
    if (tripStatus === 'generating' || tripStatus === 'places_ready') {
      nextSteps.push({ label: 'follow the trip that is still being built', tool: 'get_trip_progress' })
    }

    // Only claim something is blocked when we actually KNOW it is. An unknown count blocks
    // nothing — and neither does an empty library. That last one was here, and it was wrong:
    // `plan_trip_from_reels` requires reel_urls + dates, accepts raw pasted links, and the
    // backend runs no ownership check on them. An account with nothing saved can still plan,
    // so the empty case belongs in the counts above ("0 saved reels"), not here. Anything added
    // to this list must be a step that would genuinely FAIL if the agent tried it.
    const blocked: string[] = []
    /* Only ever from something we KNOW. An unknown status blocks nothing — claiming a trip is
       uneditable when we simply could not read it would refuse an edit the backend would allow,
       which is the same failure as the false counts above, one field along. */
    if (path === SAMPLE_TRIP_PATH) blocked.push(SAMPLE_NOT_EDITABLE)
    else if (tripStatus !== null && !EDITABLE_TRIP_STATUS.has(tripStatus)) blocked.push(TRIP_NOT_EDITABLE)

    return {
      account: 'signed_in',
      where: labelFor(path, tripStatus),
      savedReels: savedReels?.count ?? null,
      verifiedPlaces: savedReels?.places ?? null,
      trips: all === null || complete === null
        ? null
        : { total: all.length, complete, unfinished: all.length - complete },
      nextSteps,
      blocked,
    }
  }, [openTrip])

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

  /**
   * Move the page to where an action's result is visible, and do not come back until it is there.
   *
   * The one navigation seam in this component, and it is only ever reached from inside a tool's
   * `execute` — never from an effect, a subscription or a data load. That is the whole rule:
   * yanking someone off a page they are reading is worse than not moving at all, so the app moves
   * as the direct result of something the agent was just asked to do, once per action, and not
   * otherwise.
   *
   * The intent is raised BEFORE the push so the page can consume it in the same tick it mounts,
   * and awaited afterwards so the tool cannot report a result the screen has not caught up with.
   * A `router.push` for the route we are already on is skipped: the page on screen is the thing
   * that acknowledges the intent, and a redundant push is a re-render nobody asked for.
   */
  const showView = useCallback(async (reason: ViewReason) => {
    const { settled } = requestViewIntent(reason)
    if (pathRef.current !== AGENT_VIEW_ROUTE) router.push(AGENT_VIEW_ROUTE)
    // Bounded inside the intent itself, so a route that never arrives costs a beat, not the call.
    await settled
  }, [router])

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
    /* The job is filed with the MODULE, not handed to a page.
       It used to go through `registry.adoptOrganizeJob`, an optional ref owned by SavedReelsFlow
       and nulled on unmount — and the terminal navigation unmounts that page while this very
       request is in flight, so the id was dropped on the floor. Progress is DERIVED from the job
       rather than written into saved_reels (a status persisted there has no owner: a job failing
       between its steps would strand a reel reading "Analyzing…" forever), so losing the id is
       losing the progress — the user comes back to /app and reads "Not analyzed" for a job that
       is running. Filed here, the page picks it up whenever it next mounts. */
    trackOrganizeJob(res.job_id)
    void refreshReels()
    // Show the new reels straight away, if a page is there to show them.
    void refreshSavedReels.current?.()
    return res
  }, [refreshReels, refreshSavedReels])


  /**
   * Ask for this run's organize, retrying a request that fails, and resolve with whether the
   * record has been SPENT — that is, whether a job now exists for these reels.
   *
   * `true` only for an accepted job. A 409 is emphatically NOT one, and reading it as one was the
   * original defect returning for a subset: `create_saved_reels_organize_job` raises AS409 when
   * ANY requested reel overlaps an active job — `items.saved_reel_id = any(p_saved_reel_ids)` —
   * and the insert never runs, so NO job exists for the batch
   * (20260720130000_organize_job_error_codes.sql). Treating it as "these are being read right now"
   * abandoned every non-overlapping reel: no job, no retry, no notice, "Not analyzed" for ever.
   *
   * It cannot even mean "these exact reels are already running". The idempotency key is the
   * sha256 of the sorted reel-id SET (organizer._request_key), and the RPC returns the existing
   * job id for a matching key BEFORE it reaches the overlap check — so re-asking for the same
   * batch gets the job, and a 409 is always a DIFFERENT batch holding one of ours.
   *
   * So it goes on the same ladder as any other failure, which is the cheap half of the fix: an
   * overlap that ends in the meantime is simply organized. What it earns instead is its own
   * sentence, because "some were already being organized" is a different thing to be told than
   * "something went wrong".
   */
  /**
   * Replace one run's record, or drop it when the patch returns null.
   *
   * Addressed BY TOKEN, which is what makes every write safe across an await: a run that has been
   * retired, or evicted at the cap, is simply not found and the write is a no-op. New arrays and
   * new objects only — nothing here mutates a record another closure is holding.
   */
  const patchRun = useCallback((token: number, patch: (run: PlannedReels) => PlannedReels | null) => {
    const runs = plannedReelsRef.current
    const index = runs.findIndex((run) => run.token === token)
    if (index === -1) return
    const next = patch(runs[index])
    plannedReelsRef.current = next === null
      ? [...runs.slice(0, index), ...runs.slice(index + 1)]
      : [...runs.slice(0, index), next, ...runs.slice(index + 1)]
  }, [])

  const organizeForRun = useCallback(async (savedReelIds: string[]): Promise<boolean> => {
    /* The conflict sentence CLAIMS a cause — that the batch was refused because another job held
       one of these reels — so it is only earned by a ladder that saw nothing else. Keyed on the
       last error alone, a run that failed for one reason and happened to end on a 409 told the
       user the wrong story about why their reels have no places. */
    let conflictsOnly = true
    for (let attempt = 0; ; attempt += 1) {
      try {
        await analyzeReels(savedReelIds)
        // A success supersedes what an earlier attempt said about THESE reels, and nothing it
        // said about any others: an unrelated run's notice is not this run's to erase.
        clearOrganizeFailureFor(savedReelIds)
        return true
      } catch (err) {
        if (!(err instanceof ActiveOrganizeConflictError)) conflictsOnly = false
        if (attempt >= ORGANIZE_RETRY_DELAYS_MS.length) {
          recordOrganizeFailure({
            savedReelIds,
            message: conflictsOnly ? ORGANIZE_CONFLICT_MESSAGE : ORGANIZE_FAILED_MESSAGE,
          })
          return false
        }
        await wait(ORGANIZE_RETRY_DELAYS_MS[attempt])
      }
    }
  }, [analyzeReels])

  /**
   * Organize the run's reels once — and only once — that run has actually landed.
   *
   * The defect this closes: planning a trip filed the reels in the library and left every one of
   * them reading "Not analyzed · No places found yet", while the same places were on the trip map.
   * Capture was deliberately split from extraction (see `saveToLibrary` below) because an organize
   * running CONCURRENTLY with the pipeline misses the shared `reel_cache` on both sides and buys
   * the same Apify scrape twice. That cost is a function of WHEN, not whether: `_process_item`
   * reads `get_cached_places(normalized_url, EXTRACTOR_VERSION)` first, and both the daily-analysis
   * quota reserve and the Apify call live inside its `if places is None` miss branch
   * (backend/organizer.py). Run after a successful pipeline — which has just written that exact
   * key (pipeline/runner.py, same `EXTRACTOR_VERSION`) — the job normally READS that cache instead
   * of scraping again. Normally, not always, and the difference is the user's money: the runner's
   * cache write is best-effort and can fail after the paid scrape succeeded, a run can complete
   * with an individual Reel having failed, and the organizer treats a cache READ failure exactly
   * like a miss — reserving an analysis slot and extracting again. Expected, then, rather than
   * guaranteed. It is still the cheapest ordering available, which is why it is this one.
   *
   * So the gate is the successful terminal state and nothing looser:
   *   - `complete` only. `failed` would spend grounding on a trip that does not exist, and
   *     `unknown` (an unreadable result frame) is not evidence that one does.
   *   - The trip must MATCH. The store outlives this component and holds the last run either way,
   *     so a record taken for a run that has not started yet must not read a previous verdict.
   *   - One attempt at a time PER RECORD, and the record is cleared only once a job EXISTS.
   *     Clearing it before the call also fenced the duplicate frames — a late heartbeat, a
   *     repeated result — but it made one dropped connection permanently terminal: nothing was
   *     left to retry with and nothing said so. `attempting` fences the duplicates instead, which
   *     leaves the record to survive a failure. Server-side, the organize RPC fences the two-tab
   *     case harder still: it row-locks the reels and raises AS409 if any of them already sits in
   *     an active job, which arrives here as ActiveOrganizeConflictError.
   *
   * The failure never reaches the TRIP (guardrail #3): it is built, saved and on screen by the
   * time this runs, and a library write must not resurface as a trip failure. It is not swallowed
   * either — `organizeForRun` files it, and the library page says so the next time it is on screen.
   */
  const maybeOrganize = useCallback(() => {
    const snap = shell.store.snapshot()
    /* Record the verdict while the store still holds it. `complete` is the only status that earns
       anything: `failed` would spend grounding on a trip that does not exist, and `unknown` (an
       unreadable result frame) is not evidence that one does — those records simply stay inert. */
    if (snap?.status === 'complete') {
      plannedReelsRef.current = plannedReelsRef.current.map(
        (run) => (run.tripId === snap.tripId && !run.landed ? { ...run, landed: true } : run),
      )
    }
    for (const run of plannedReelsRef.current) {
      if (!run.landed) continue
      // Captures still landing. Organizing a subset here would file a job for some of the run's
      // reels and silently drop the rest — the last capture to settle asks again.
      if (run.pending > 0) continue
      if (run.savedReelIds.length === 0) continue
      if (run.attempting) continue
      patchRun(run.token, (r) => ({ ...r, attempting: true }))
      void (async () => {
        let spent = false
        try {
          spent = await organizeForRun(run.savedReelIds)
        } catch {
          // `organizeForRun` reports its own outcomes; a throw out of it is a bug, and it must
          // still not escape into the stream's call stack with nothing there to receive it.
        }
        // Spent: a job exists for these reels, so the run is owed nothing more. Otherwise the
        // fence lifts and the reels stay, so a later capture or frame can try again. Addressed by
        // token, so a record already retired is simply not there to write to.
        patchRun(run.token, (r) => (spent ? null : { ...r, attempting: false }))
      })()
    }
  }, [shell, organizeForRun, patchRun])

  useEffect(() => {
    const unsubscribe = shell.store.subscribe(maybeOrganize)
    // Wrapped rather than returned directly: `subscribe` hands back a Set#delete, whose boolean
    // is not the `void` a cleanup may return.
    return () => { unsubscribe() }
  }, [shell, maybeOrganize])

  /**
   * Capture a reel for the run now starting, and remember that this run is what planned from it.
   *
   * The plain `saveReel` is what `save_reels` uses; this is the same capture plus a note of WHICH
   * reels belong to the run, because that note is the only thing that can answer "organize which?"
   * once the run lands. Recorded here rather than returned to the tool: the tool call ends in
   * about a second and the run it started has another two minutes to go.
   *
   * A capture that fails records nothing, which is right — there is no row to organize.
   *
   * The run is identified BEFORE the await and compared after it. Reading only `.current` on the
   * way out wrote into whatever record happened to be open when the save landed, so two runs in
   * one session cross-contaminated: run A's slow capture became one of run B's reels, and run B's
   * organize then paid to read a reel it never planned from while run A's reel was still owed one.
   * `create` opens the record before any capture starts (see the tool's ordering), so a capture
   * with no token to carry is a capture with no run behind it.
   */
  const saveReelForRun = useCallback(async (url: string) => {
    // The run now starting is the newest record — `create` opens it before any capture begins.
    const runs = plannedReelsRef.current
    const token = runs.length > 0 ? runs[runs.length - 1].token : null
    // Counted BEFORE the await, so a terminal frame arriving mid-capture can see that this batch
    // is not finished yet. The tool starts every capture in one synchronous map, so all of them
    // are counted in before any can settle.
    if (token !== null) patchRun(token, (r) => ({ ...r, pending: r.pending + 1 }))
    try {
      const saved = await saveReel(url)
      // Addressed by token, so a capture that outlived its run writes nowhere rather than into
      // whichever record happens to be newest now.
      if (token !== null) {
        patchRun(token, (r) => ({ ...r, savedReelIds: [...r.savedReelIds, saved.id] }))
      }
      return saved
    } finally {
      if (token !== null) patchRun(token, (r) => ({ ...r, pending: r.pending - 1 }))
      /* ...and ask again, because the run may already have landed while this was in flight. A
         capture that FAILED asks too: it has no row to organize, but the reels that did land are
         still owed a job and must not wait on a sibling that is never coming. */
      maybeOrganize()
    }
  }, [saveReel, maybeOrganize, patchRun])

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
        /* No wiping of what the last run left behind — that was the two-run defect. A previous
           run's record is inert unless it LANDED, and a landed one is an obligation this run has
           no business cancelling: its captures may still be in flight. */
        try {
          const token = await getAccessToken()
          const res = await generateTrip(req, token)
          // Opened here, filled by `saveReelForRun` as the captures land a moment later. Empty is
          // the honest starting value: nothing has been saved yet, and nothing is owed an organize
          // until something has. The token is what a capture carries across its own await, so a
          // slow one from the PREVIOUS run cannot be filed against this record.
          runTokenRef.current += 1
          plannedReelsRef.current = [
            ...plannedReelsRef.current,
            {
              token: runTokenRef.current, tripId: res.trip_id, savedReelIds: [],
              pending: 0, landed: false, attempting: false,
            },
          ].slice(-MAX_PLANNED_RUNS)
          return res.trip_id
        } catch (err) {
          // No backend job exists, so the lock goes back immediately. Holding it would block
          // every later generation — the agent's and the user's — for the rest of the session.
          reservationRef.current = null
          reservation.release()
          throw err
        }
      },
      openStream: async (tripId: string) => {
        // Commits the reservation `create` took: the shell opens the one stream, keeps the event
        // history the wait screen renders from, and navigates when it finishes. It never awaits
        // the STREAM — the tool must resolve in about a second, the pipeline runs for 60-180.
        const reservation = reservationRef.current
        reservationRef.current = null
        // No reservation means no lock is held by this call, and starting a stream anyway is
        // exactly the second unowned run the reservation exists to prevent. `begin` applies the
        // same rule to a reservation that expired while the POST above was in flight: it reports
        // the job as orphaned rather than opening a stream on a lock it no longer holds.
        //
        // ...and with no run attached there is nothing for the page to show, so nothing moves:
        // /app would render the plain library while the agent announced a trip being built.
        if (!reservation) return
        reservation.begin(tripId)
        /* Then the screen follows. GenerationScene renders only inside SavedReelsFlow — only on
           /app — so a run started from /app/settings or /app/trips took the agent's longest and
           most visible action and made it invisible for two minutes, ending in a teleport to a
           finished trip. Attached FIRST, moved second: the page it lands on already has a run to
           render, instead of flashing an empty library on the way. */
        await showView('trip-generation')
      },
      confirm: requestConfirm,
      /* Only to decide what to SAY when the user states no preferences: ask them once if
         nothing is remembered, or note on the card that saved preferences will be used.
         Never a gate on the trip itself — see readMemoryState. */
      readMemory: getMemoryPreferences,
      readLibrary: loadSavedReels,
      /* The CAPTURE half only, still deliberately not `analyzeReels` — but no longer the end of
         the story. Planning from raw links used to read this library and never write to it, so the
         reels a trip was built from never appeared in the collection. Capture is a plain upsert
         that also links the reel's `reel_cache` row by normalized_url, which is what puts the
         caption and cover back on the card for a reel Astrail has already read.
         Extraction stays out OF THIS CALL because an organize job racing the generation would miss
         the shared cache on both sides and buy the same Apify scrape twice, every time. It is not
         left to the agent to remember: `saveReelForRun` notes which reels this run planned from,
         and the subscription above organizes them the moment the run lands — after the pipeline
         has normally filled the cache, so the job normally reads it rather than scraping again.
         Normally: see that subscription for the four ways this ordering still costs a read. */
      saveToLibrary: saveReelForRun,
      readAllowance,
    }),
    [requestConfirm, loadSavedReels, saveReelForRun, readAllowance, shell, showView],
  )

  /**
   * Where each trip's prose stands relative to its stops, and what is being done about it.
   *
   * A ref rather than state: nothing renders from it, and a re-render must not drop it — the
   * whole point is that a rewrite started by `remove_place` is still findable by the
   * `replan_trip` the agent calls a beat later.
   *
   * `edits` is the version the prose has to catch up to, and it is why this is a record rather
   * than a bare promise. The FIRST version of this coalesced any second caller into the run
   * already in flight, which is wrong in a way that is invisible from here: `persist_narration`
   * (backend/pipeline/persist.py) reads the trip's stops, THEN awaits the narrator for ~30s, then
   * writes the prose. A run that started before an edit therefore writes prose that cannot know
   * about it — so joining it and reporting the summaries as current states the opposite of the
   * truth, on the surface this whole feature exists to keep honest. A join is only safe when the
   * run in flight was started after every edit THIS TAB HAS OBSERVED, which is exactly `covers ===
   * edits`. Anything else queues ONE follow-up instead, which keeps the saving that coalescing
   * was for — N edits during a rewrite still cost two narrations, not N + 1.
   */
  type TripRewrites = {
    /** Mutations that have landed for this trip, counted here because only this app knows. */
    edits: number
    /**
     * The run in flight, with the `edits` value its backend snapshot includes.
     *
     * "Includes" as far as THIS TAB can know. `edits` is an in-memory counter, so the guarantee
     * is session-local by construction: two tabs open on one trip count independently, both can
     * start a rewrite, and if the newer one finishes first the older snapshot's prose lands last
     * and wins. Closing that needs a version the SERVER owns, which is a bigger change than this
     * one and deliberately not made here — the counter still removes the common case, which is
     * one tab making several edits in a row.
     */
    running: { promise: Promise<ReplanTripResult>; covers: number } | null
    /** The single follow-up owed to everyone waiting for a run newer than the one in flight. */
    follow: {
      promise: Promise<ReplanTripResult>
      resolve: (r: ReplanTripResult) => void
      reject: (e: unknown) => void
    } | null
  }
  const rewrites = useRef<Map<string, TripRewrites>>(new Map())

  const rewriteState = useCallback((tripId: string): TripRewrites => {
    const existing = rewrites.current.get(tripId)
    if (existing) return existing
    const fresh: TripRewrites = { edits: 0, running: null, follow: null }
    rewrites.current.set(tripId, fresh)
    return fresh
  }, [])

  /**
   * Rewrite the summaries once, and say so where the user can see it.
   *
   * Every itinerary edit starts one of these (see `startSummaryRewrite` in
   * `lib/webmcp/tools/edit.ts`), which makes both of these jobs load-bearing rather than tidy:
   *
   *  - COALESCE, but only where it is true. The agent has spent this whole feature being told to
   *    call `replan_trip` after an edit, and models do not unlearn that the day a tool description
   *    changes; without any coalescing the obedient agent buys a second narration of the same trip
   *    whose only effect is to overwrite the first one's prose. The version check above is what
   *    keeps that saving from becoming a lie.
   *  - ANNOUNCE. This is an LLM call nobody approved. It costs no trip allowance, but work done
   *    on the user's behalf that they cannot see is work they could not have consented to, and
   *    the activity rail is this app's answer to that everywhere else. It also does double duty
   *    as the "updating the plan" state: the entry sits at `REWRITE`, pulsing, for as long as the
   *    narration runs, which is what stops a briefly-stale summary from being a silent one. A
   *    follow-up is a second real narration and gets its own entry, because it is one.
   *
   * At most one run per trip is in flight FROM THIS TAB, which is what stops an older snapshot's
   * prose landing on top of a newer one's. Two things fall outside that, and neither is fixable
   * from here: a second tab counts its own edits and can have a rewrite of its own running, and a
   * client timeout stops this tab waiting without stopping the server task it started — so the
   * next run can begin while the abandoned one is still narrating. `replanTrip`'s timeout message
   * says so and steers away from an immediate retry for exactly that reason. The real fix for
   * both is a version the server owns.
   *
   * It rejects on failure, and that is deliberate too: `replan_trip` reports what went wrong from
   * the rejection, and guardrail #3 lives on the other side of it — the caller that started this
   * in the background swallows the rejection so a failed rewrite can never fail the edit that
   * already landed.
   */
  const startReplanRun = useCallback(
    (tripId: string, state: TripRewrites, afterEdit: boolean): Promise<ReplanTripResult> => {
      const covers = state.edits
      const run = (async () => {
        /* The entry opens AFTER the token, not before, and the trip page depends on the
           difference. Its "Updating this day's summary" marker keys on a running subject-tagged
           entry, so an entry opened first would light the marker while `getAccessToken()` was
           still reading Supabase's session behind its auth lock — which can stall, and the marker
           would then stand indefinitely with no request in flight. Same lie as the one the
           approval card used to tell, one step earlier.
           The entry `RegisterTools` opens for the tool CALL is untagged for the same reason: it
           starts before `execute` and spans the card.
           What this does not close: a token that never settles at all leaves no entry and holds
           the trip's slot in `rewrites` — the wedge the fetch timeout closes for the request,
           still open for the token. It needs a bound of its own. */
        let entry: number | undefined
        try {
          const token = await getAccessToken()
          entry = beginActivity('replan_trip', tripId)
          const result = await replanTrip(tripId, token)
          const days = result.days_narrated
          endActivity(
            entry,
            'done',
            `Rewrote ${days} day summar${days === 1 ? 'y' : 'ies'} to match the current stops.` +
              (result.routes_refreshed ? ' Routes recalculated.' : ' Routes could not be recalculated this time.'),
          )
          return result
        } catch (e) {
          /* `afterEdit` decides the first clause, and it has to: a rewrite the agent asked for
             with no edit behind it has no edit to reassure anyone about, and saying "the edit was
             saved" there invents one — the same class of false record as the REMOVED entry
             written for a removal the user had refused. When there WAS an edit it is already
             persisted, and a bare "failed" reads as it having been rolled back. */
          const why = e instanceof Error ? ` — ${e.message}` : '.'
          /* Opened here when the token is what failed, so a rewrite that never got as far as a
             request is still recorded rather than disappearing. Nothing was spent on that path,
             but the edit it belongs to still owes the user the reason its summaries did not
             refresh. */
          const id = entry ?? beginActivity('replan_trip', tripId)
          endActivity(
            id,
            'failed',
            afterEdit
              ? `The edit was saved, but the day summaries could not be rewritten${why}`
              : `The day summaries could not be rewritten${why}`,
          )
          throw e
        } finally {
          state.running = null
          /* Settled, so the queued edits can have the run they are owed. Started on BOTH endings:
             a failed rewrite does not cancel the obligation, and the follow-up reads the trip
             fresh either way. It inherits `afterEdit` because a follow-up exists only because
             edits landed. */
          const follow = state.follow
          if (follow) {
            state.follow = null
            startReplanRun(tripId, state, true).then(follow.resolve, follow.reject)
          }
        }
      })()
      /* Registered after the call is under way but before control leaves this function, so a
         second caller in the same turn can only ever find it — never miss it and start its own. */
      state.running = { promise: run, covers }
      return run
    },
    [beginActivity, endActivity],
  )

  /**
   * The rewrite a caller is owed: the one in flight if it already covers every landed edit,
   * otherwise the follow-up that will.
   *
   * `afterEdit` is what tells the two callers apart, and it is not a nicety. An edit RAISES the
   * version the prose owes, so it can never be satisfied by a run that started before it — before
   * it AS THIS TAB SAW IT, which is the whole of what `edits` can know. A bare "make the prose
   * current" request raises nothing and is happy with a run already under way. Collapsing them
   * would either lose the coalescing entirely or reinstate the stale-join bug.
   */
  const runReplan = useCallback(
    (tripId: string, opts?: { afterEdit?: boolean }): Promise<ReplanTripResult> => {
      const state = rewriteState(tripId)
      if (opts?.afterEdit) state.edits += 1

      if (state.running) {
        if (state.running.covers === state.edits) return state.running.promise
        if (!state.follow) {
          let resolve!: (r: ReplanTripResult) => void
          let reject!: (e: unknown) => void
          const promise = new Promise<ReplanTripResult>((res, rej) => { resolve = res; reject = rej })
          state.follow = { promise, resolve, reject }
        }
        return state.follow.promise
      }

      return startReplanRun(tripId, state, opts?.afterEdit === true)
    },
    [rewriteState, startReplanRun],
  )

  const edit = useMemo(
    () => ({
      add: async (tripId: string, body: Parameters<typeof addTripPlace>[1]) =>
        addTripPlace(tripId, body, await getAccessToken()),
      setDates: async (tripId: string, body: Parameters<typeof editTripDates>[1]) =>
        editTripDates(tripId, body, await getAccessToken()),
      replan: runReplan,
      // `running`, not `has`: the record outlives the run it describes (it carries the edit
      // count for the session), so asking whether the MAP knows this trip would answer "a
      // rewrite is running" forever after the first edit — and `replan_trip` would stop asking
      // for approval on every later call.
      replanInFlight: (tripId: string) => rewrites.current.get(tripId)?.running != null,
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
    [requestConfirm, runReplan],
  )

  /* The saved-reel library, put on screen once a save has actually landed. `save_reels` decides
     WHEN — once per batch, and only if something was saved — because it is the only thing that
     knows the batch's outcome; this only knows where the library is.

     The LIST first, then the screen. The Library renders the page's own cards, so revealing
     before that list has caught up shows "No saved reels yet" until the fetch lands — and the
     account most likely to hit that is the one saving for the very first time, where the sentence
     is not just stale but the exact opposite of what just happened. The per-save refreshes in
     `saveReel` cannot be this guarantee: each is fire-and-forget and any of them can resolve
     before a later reel in the same batch lands. This one runs after all of them, once.

     Its failure is not the reveal's. A list that would not reload is a stale library; not showing
     up at all is the defect this whole channel exists to fix, so a refused refresh still gets the
     screen — and `save_reels` still reports the save either way. */
  const revealSavedReels = useCallback(async () => {
    try {
      await refreshSavedReels.current?.()
    } catch {
      // Stale beats absent. Nothing is owed to the report: the reels ARE saved.
    }
    await showView('saved-reels')
  }, [showView, refreshSavedReels])

  /* Built twice from one context, so the two readers cannot drift apart: everything is assembled
     against the write-safe reader, then the READ-ONLY tools are swapped for the copies that can
     see the sample. Keyed on `readOnlyHint`, not on a list of names — a write tool added later is
     sample-blind by default, and an unmatched name degrades to the strict spec rather than the
     permissive one. `save_reels` and `plan_trip_from_reels` are writes that never touch `trips`,
     so the strict reader costs them nothing. */
  const deps = {
    readAppState, saveReel, analyzeReels, loadSavedReels, revealSavedReels, generation, edit,
    // Reads the caller's own mem0 memories through the backend, which derives the user from
    // the token — one user can never read another's (guardrail #5/#6).
    preferences: { load: getMemoryPreferences },
  }
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
     sample trail holds a JWT, and all fourteen work for them there.

     Unknown fails SMALL (`!== true`, not `=== false`), so the list only ever GROWS: a signed-in
     visitor to this route sees three, then fourteen. The other direction would show a judge the
     full list and then take most of it away, advertising failures during exactly the window a
     freshly loaded agent reads the list. An under-advertised tool costs a question; an over-advertised one
     costs a failed call the agent was invited to make. */
  const offered = isPublicSample(pathname, hasSession)
    ? specs.filter((s) => PUBLIC_SAMPLE_TOOLS.has(s.name))
    : specs

  return <RegisterTools specs={offered} />
}
