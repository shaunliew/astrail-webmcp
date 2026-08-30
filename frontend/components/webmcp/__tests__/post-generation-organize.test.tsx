import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEffect } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import type { StreamEvent } from '@/lib/trip/backend-types'
import type { Entitlement } from '@/lib/entitlement'
import type { ToolSpec } from '@/lib/webmcp/types'
import type { GenerationStore } from '@/lib/webmcp/generation'

/**
 * The reels a generation planned from, organized once that generation lands.
 *
 * The reported defect: planning a trip put the reels in the library and left every one of them
 * reading "Not analyzed · No places found yet", while the same places were on the trip map two
 * clicks away. `plan_trip_from_reels` captures each reel (which is why the rows exist) but
 * deliberately never queued extraction, because an organize job running CONCURRENTLY with the
 * pipeline misses the shared `reel_cache` on both sides and buys the same Apify scrape twice.
 *
 * Sequenced AFTER a successful run, the same job is free: `organizer._process_item` reads
 * `get_cached_places(normalized_url, EXTRACTOR_VERSION)` first and both the daily-analysis quota
 * reserve and the Apify call sit inside its `if places is None` miss branch, while the runner has
 * just written that exact key. So the whole fix is a question of WHEN, and these tests pin the
 * when: on success, once, for that run's reels only, and never at the cost of the trip.
 */

type Reservation = { begin: (tripId: string) => void; release: () => void }
/** Mirrors the real shell, null reservation included — that null IS the single-run lock. */
type Shell = { store: GenerationStore; reserve: () => Reservation | null }

const h = vi.hoisted(() => ({
  specs: [] as ToolSpec[],
  shell: null as Shell | null,
  /** The stream's event sink, captured when the shell opens a run. */
  emit: null as ((e: StreamEvent) => void) | null,
  captureSavedReel: vi.fn<(url: string, token: string) => Promise<{ saved_reel: { id: string } }>>(),
  startOrganize: vi.fn<(ids: string[], token: string) => Promise<{ job_id: string }>>(),
  generateTrip: vi.fn<(...args: unknown[]) => Promise<{ trip_id: string }>>(),
  readEntitlement: vi.fn<() => Promise<Entitlement>>(),
}))

vi.mock('next/navigation', () => ({ usePathname: () => '/app', useRouter: () => ({ push: vi.fn() }) }))

vi.mock('@/lib/trip/supabase-api', () => ({ listTrips: () => Promise.resolve([]), getTrip: vi.fn() }))

/* The three network calls are stubbed; everything else comes from the REAL module. The conflict
   error GlobalTools branches on is a class exported from there, and a factory that omitted it made
   `instanceof` compare against undefined — a mock that silently disables the branch under test. */
vi.mock('@/lib/reels/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/reels/api')>(),
  listSavedReelCards: () => Promise.resolve([]),
  captureSavedReel: (url: string, token: string) => h.captureSavedReel(url, token),
  startOrganize: (ids: string[], token: string) => h.startOrganize(ids, token),
}))

vi.mock('@/lib/supabase/session', () => ({ getAccessToken: () => Promise.resolve('test-token') }))

vi.mock('@/lib/trip/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/trip/api')>(),
  addTripPlace: vi.fn(), deleteTripPlace: vi.fn(), editTripDates: vi.fn(),
  editTripPlace: vi.fn(), replanTrip: vi.fn(),
  generateTrip: (...args: unknown[]) => h.generateTrip(...args),
}))

vi.mock('@/lib/entitlement', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/entitlement')>(),
  readEntitlement: () => h.readEntitlement(),
}))

/* The real intent waits up to VIEW_INTENT_TIMEOUT_MS (3s) for a page to acknowledge the move.
   Nothing here renders that page, so every plan call would pay the full timeout for a navigation
   that is not what these tests are about. */
vi.mock('@/lib/webmcp/view-intent', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/webmcp/view-intent')>(),
  requestViewIntent: () => ({ intent: { id: 0, reason: 'trip-generation' }, settled: Promise.resolve() }),
}))

/* The shell, not a stub of it: `useGeneration` hands back whatever the test built, and the store
   inside it is the REAL `createGenerationStore`. The terminal transition under test is the store's
   own `statusFromResult` rule, so a hand-rolled fake status would pin nothing. */
vi.mock('@/components/generation/GenerationProvider', () => ({ useGeneration: () => h.shell }))

vi.mock('../RegisterTools', () => ({
  RegisterTools: ({ specs }: { specs: ToolSpec[] }) => { h.specs = specs; return null },
}))

const { createGenerationStore } = await import('@/lib/webmcp/generation')
const { ActiveOrganizeConflictError } = await import('@/lib/reels/api')
const { ORGANIZE_FAILED_MESSAGE, organizeJobs, resetOrganizeJobs } = await import('@/lib/reels/organize-jobs')
const { WebMcpRegistryProvider, useWebMcpRegistry } = await import('../WebMcpRegistry')
const { default: GlobalTools, ORGANIZE_RETRY_DELAYS_MS } = await import('../GlobalTools')

/** Total time the retry ladder can take, plus room for the calls themselves. */
const RETRY_WINDOW_MS = ORGANIZE_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) + 2_000

/**
 * Attempts a failing organize gets, pinned as a NUMBER.
 *
 * Deliberately not `ORGANIZE_RETRY_DELAYS_MS.length + 1`: derived from the constant, the
 * assertion holds for an empty ladder too, so deleting every retry left the test green. The
 * policy is "one attempt plus two retries", and a change to it should have to be made here.
 */
const ORGANIZE_ATTEMPTS = 3

/** A promise this test resolves by hand, so a request can still be in flight at a chosen moment. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

/**
 * A shell whose reservation opens a real run on a real store, and hands us its event sink.
 *
 * The single-run LOCK is modelled too, because it is what a second plan call actually meets: the
 * real `reserve()` returns null while a run is live, and `create` turns that into a throw.
 */
function makeShell(): Shell {
  const store = createGenerationStore()
  let locked = false
  // The real shell hands the lock back the moment a run reaches a verdict, so the next
  // generation is not refused forever by a run that is already over.
  store.subscribe(() => { if (store.snapshot()?.status !== 'generating') locked = false })
  return {
    store,
    reserve: () => (locked ? null : {
      begin: (tripId: string) => {
        locked = true
        store.start(tripId, (onEvent) => { h.emit = onEvent; return { cancel: () => {} } })
      },
      release: () => { locked = false },
    }),
  }
}

/** Starts a run this component did not create — what the manual flow does with the same store. */
function startForeignRun(tripId: string) {
  act(() => {
    h.shell!.store.start(tripId, (onEvent) => { h.emit = onEvent; return { cancel: () => {} } })
  })
}

/** Answers the approval card, so the spend the tool asks about is actually consented to. */
function AutoApprove() {
  const { pending } = useWebMcpRegistry()
  useEffect(() => { pending?.resolve(true) }, [pending])
  return null
}

const PLAN_ARGS = {
  reel_urls: ['https://www.instagram.com/reel/Cabc123/', 'https://www.instagram.com/reel/Cdef456/'],
  start_date: '2026-03-03',
  end_date: '2026-03-07',
}

const SUCCESS: StreamEvent = { type: 'result', content: JSON.stringify({ itinerary: { days: [] } }) }
const FAILURE: StreamEvent = { type: 'result', content: JSON.stringify({ error: 'scrape failed' }) }

async function mountTools(): Promise<{ plan: ToolSpec; unmount: () => void }> {
  const { unmount } = render(
    <WebMcpRegistryProvider><GlobalTools /><AutoApprove /></WebMcpRegistryProvider>,
  )
  let plan: ToolSpec | undefined
  await waitFor(() => {
    plan = h.specs.find((s) => s.name === 'plan_trip_from_reels')
    expect(plan, 'plan_trip_from_reels was never built').toBeTruthy()
  })
  return { plan: plan!, unmount }
}

/** Runs a generation to the point where it is streaming and its reels are in the library. */
async function planTrip(): Promise<{ result: string; unmount: () => void }> {
  const { plan, unmount } = await mountTools()
  return { result: await runPlan(plan, PLAN_ARGS), unmount }
}

/* NOT wrapped in act(): the tool awaits its own approval card, and AutoApprove answers from an
   effect. act() defers effects to the end of its scope, and that scope cannot end while it is
   awaiting the call the effect has to unblock — so wrapping deadlocks the whole flow. The act
   warnings this leaves behind are the same ones GlobalTools.test.tsx has always emitted for the
   same reason. */
async function runPlan(plan: ToolSpec, args: Record<string, unknown>): Promise<string> {
  return String(await plan.execute(args))
}

/** Delivers a terminal frame the way the stream would. */
function land(event: StreamEvent) {
  act(() => { h.emit?.(event) })
}

beforeEach(() => {
  // The job store is a module, so it outlives a render the way it outlives a page — which is the
  // whole point of it, and exactly why each test has to start from empty.
  resetOrganizeJobs()
  h.specs = []
  h.shell = makeShell()
  h.emit = null
  h.captureSavedReel.mockReset()
  h.startOrganize.mockReset()
  h.generateTrip.mockReset()
  h.readEntitlement.mockReset()
  h.readEntitlement.mockResolvedValue({ plan: 'trial', lifetimeTripCount: 0, seatRequestedAt: null })
  h.generateTrip.mockResolvedValue({ trip_id: 'trip-1' })
  h.startOrganize.mockResolvedValue({ job_id: 'job-1' })
  let n = 0
  h.captureSavedReel.mockImplementation(() => Promise.resolve({ saved_reel: { id: `reel-${++n}` } }))
})

describe('organizing the reels a generation planned from', () => {
  it('organizes them once the run completes', async () => {
    await planTrip()
    land(SUCCESS)
    await waitFor(() => { expect(h.startOrganize).toHaveBeenCalledTimes(1) })
    expect(h.startOrganize).toHaveBeenCalledWith(['reel-1', 'reel-2'], 'test-token')
  })

  it('organizes only the reels THAT run planned, not the rest of the library', async () => {
    // The library may hold dozens of reels; organizing all of them would spend grounding on
    // reels this run never read, and the ones it did read are the only ones with a warm cache.
    await planTrip()
    land(SUCCESS)
    await waitFor(() => { expect(h.startOrganize).toHaveBeenCalledTimes(1) })
    const ids = h.startOrganize.mock.calls[0][0]
    expect(ids).toEqual(['reel-1', 'reel-2'])
    expect(ids).toHaveLength(PLAN_ARGS.reel_urls.length)
  })

  it('does not organize while the run is still generating', async () => {
    // The whole reason capture and extraction were split: an organize racing the pipeline misses
    // the shared cache on both sides and pays Apify twice for the same reel.
    await planTrip()
    land({ type: 'stage', stage: 'scrape', msg: 'Reading your reels' })
    land({ type: 'heartbeat', elapsed_s: 30 })
    land({ type: 'decision', stage: 'extract', msg: 'Found 6 places' })
    await Promise.resolve()
    expect(h.startOrganize).not.toHaveBeenCalled()
  })

  it('does not organize when the run fails', async () => {
    // Grounding spent on a trip that does not exist, for a user who has nothing to show for it.
    await planTrip()
    land(FAILURE)
    await Promise.resolve()
    expect(h.startOrganize).not.toHaveBeenCalled()
  })

  it('does not organize when the terminal frame is unreadable', async () => {
    // `unreadable` is not evidence of a finished trip. The store maps it to `unknown`, and an
    // unknown run is not the successful terminal state this is gated on.
    await planTrip()
    land({ type: 'result', content: 'not json at all' })
    await Promise.resolve()
    expect(h.startOrganize).not.toHaveBeenCalled()
  })

  it('does not organize when the pipeline reports an error event', async () => {
    await planTrip()
    land({ type: 'error', stage: 'scrape', msg: 'Apify is down' })
    await Promise.resolve()
    expect(h.startOrganize).not.toHaveBeenCalled()
  })

  it('leaves the trip intact when organizing fails, and lets nothing escape', async () => {
    /* Guardrail #3: the trip is already built and saved by the time this runs. A library write
       must never surface as a trip failure — and the 409 a second tab earns is the server-side
       fence working, not an error anyone needs to read. The unhandled-rejection assertion is the
       half that has teeth: without the `.catch`, the rejection escapes the subscription callback
       into the stream's own call stack, where nothing is waiting to receive it. */
    const escaped: unknown[] = []
    const record = (reason: unknown) => { escaped.push(reason) }
    process.on('unhandledRejection', record)
    try {
      h.startOrganize.mockRejectedValue(new ActiveOrganizeConflictError())
      const { result } = await planTrip()
      land(SUCCESS)
      await waitFor(() => { expect(h.startOrganize).toHaveBeenCalledTimes(1) })
      // Long enough for a rejection with no handler to be reported as one.
      await new Promise((r) => setTimeout(r, 50))
      expect(escaped).toEqual([])
      expect(JSON.parse(result).trip_id).toBe('trip-1')
      expect(h.shell!.store.snapshot()?.status).toBe('complete')
    } finally {
      process.off('unhandledRejection', record)
    }
  })

  it('does not organize a FAILED run\'s reels when a later run succeeds', async () => {
    /* The record of a failed run is never spent — nothing clears it, because nothing organized.
       The store is shared with the manual flow, so the next successful run may well be one this
       component never started, and its `complete` frame must not be read as the failed run's.
       Organizing then would be the expensive mistake twice over: the failed run filled no cache,
       so every one of those reels would MISS and buy a real Apify scrape. */
    await planTrip()
    land(FAILURE)
    startForeignRun('trip-manual')
    land(SUCCESS)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.startOrganize).not.toHaveBeenCalled()
  })

  it('still organizes when a second plan call is refused mid-run', async () => {
    /* Two tabs, or the user clicking Generate while the agent is already building. The second
       call is refused by the run lock before it creates anything — and it must not disturb the
       live run's record on its way out, or the reels of the trip that IS being built silently
       stop being organized. */
    const { plan } = await mountTools()
    await runPlan(plan, PLAN_ARGS)
    // The lock refusal is not one of the two entitlement refusals the tool translates, so it
    // comes back out of `execute` as a throw.
    await expect(runPlan(plan, PLAN_ARGS)).rejects.toThrow(/already being built/)
    land(SUCCESS)
    await waitFor(() => { expect(h.startOrganize).toHaveBeenCalledTimes(1) })
    expect(h.startOrganize).toHaveBeenCalledWith(['reel-1', 'reel-2'], 'test-token')
  })

  it('organizes once, not once per store notification', async () => {
    await planTrip()
    land(SUCCESS)
    await waitFor(() => { expect(h.startOrganize).toHaveBeenCalledTimes(1) })
    // More frames after the verdict — a late heartbeat, a duplicate result — must not re-fire.
    land({ type: 'heartbeat', elapsed_s: 91 })
    land(SUCCESS)
    await Promise.resolve()
    expect(h.startOrganize).toHaveBeenCalledTimes(1)
  })

  it('does not organize again when the tools remount over a finished run', async () => {
    // The store outlives this component (it belongs to the shell), so a remount re-subscribes to
    // a run that is already `complete`. Two tabs are fenced server-side; a remount is not, and
    // would otherwise queue a second organize for reels the first one is already working.
    const { unmount } = await planTrip()
    land(SUCCESS)
    await waitFor(() => { expect(h.startOrganize).toHaveBeenCalledTimes(1) })
    unmount()
    await mountTools()
    land({ type: 'heartbeat', elapsed_s: 120 })
    await Promise.resolve()
    expect(h.startOrganize).toHaveBeenCalledTimes(1)
  })

  it('does not organize a previous run\'s reels when a new run starts', async () => {
    // The record belongs to ONE run. A second generation must not inherit the first's reels —
    // and must not organize them on ITS terminal frame, which would be a second, unfenced job.
    const { plan } = await mountTools()
    await runPlan(plan, PLAN_ARGS)
    land(FAILURE)
    h.generateTrip.mockResolvedValue({ trip_id: 'trip-2' })
    h.captureSavedReel.mockResolvedValue({ saved_reel: { id: 'reel-9' } })
    await runPlan(plan, { ...PLAN_ARGS, reel_urls: ['https://www.instagram.com/reel/Cxyz789/'] })
    land(SUCCESS)
    await waitFor(() => { expect(h.startOrganize).toHaveBeenCalledTimes(1) })
    expect(h.startOrganize).toHaveBeenCalledWith(['reel-9'], 'test-token')
  })

  it('does not organize when nothing could be saved to the library', async () => {
    // No rows means no ids, and `startOrganize([])` is a job over an empty set — the backend RPC
    // would take it, and the user would watch an organize that organizes nothing.
    h.captureSavedReel.mockRejectedValue(new Error('rate limited'))
    await planTrip()
    land(SUCCESS)
    await Promise.resolve()
    expect(h.startOrganize).not.toHaveBeenCalled()
  })
})

describe('the organize outlives the page that started it', () => {
  /* The race Codex found: `GenerationProvider` marks the run terminal and navigates to the trip in
     the same breath, which unmounts the library page — while `startOrganize` is still awaiting its
     response. The job id used to be handed to that page through an OPTIONAL ref the page owned and
     nulled on unmount, so the id was dropped on the floor; and an id that did land lived in that
     page's own state and died with it. Either way the user came back to /app and read "Not
     analyzed" for a job running perfectly well — the very complaint this feature exists to answer.

     So the job is owned by a module now. These tests are about that ownership, not about the
     poll — what a followed job renders is SavedReelsFlow's own suite. */

  it('follows the job even when the page unmounts before the request lands', async () => {
    const started = deferred<{ job_id: string }>()
    h.startOrganize.mockImplementation(() => started.promise)
    const { unmount } = await planTrip()
    land(SUCCESS)
    await waitFor(() => { expect(h.startOrganize).toHaveBeenCalledTimes(1) })

    // The navigation, at its worst: everything React owns goes away mid-request.
    unmount()
    started.resolve({ job_id: 'job-late' })

    await waitFor(() => { expect(organizeJobs().jobIds).toEqual(['job-late']) })
  })

  it('retries a request that fails, and keeps the reels for the attempt after that', async () => {
    /* The record used to be cleared BEFORE the call, so one dropped connection was permanently
       terminal: nothing was left to retry with and nothing said so. */
    h.startOrganize.mockRejectedValue(new Error('network blip'))
    await planTrip()
    land(SUCCESS)

    await waitFor(
      () => { expect(h.startOrganize).toHaveBeenCalledTimes(ORGANIZE_ATTEMPTS) },
      { timeout: RETRY_WINDOW_MS },
    )
    expect(ORGANIZE_RETRY_DELAYS_MS).toHaveLength(ORGANIZE_ATTEMPTS - 1)
    // Every attempt asked for the same reels — the record survived all of them.
    for (const call of h.startOrganize.mock.calls) expect(call[0]).toEqual(['reel-1', 'reel-2'])

    // ...and it is still there for the next terminal frame, which is what "retryable" means.
    h.startOrganize.mockResolvedValue({ job_id: 'job-2' })
    await act(async () => { await Promise.resolve() })
    land(SUCCESS)
    await waitFor(() => { expect(organizeJobs().jobIds).toEqual(['job-2']) })
    expect(h.startOrganize).toHaveBeenLastCalledWith(['reel-1', 'reel-2'], 'test-token')
  })

  it('says so, where the user will see it, when it runs out of attempts', async () => {
    // Swallowing is right for the TRIP (guardrail #3 — the trip is built and on screen), and
    // wrong for the library: those reels have no places and nothing would ever have said why.
    h.startOrganize.mockRejectedValue(new Error('network blip'))
    await planTrip()
    land(SUCCESS)

    await waitFor(
      () => { expect(organizeJobs().failure).not.toBeNull() },
      { timeout: RETRY_WINDOW_MS },
    )
    expect(organizeJobs().failure).toEqual({
      savedReelIds: ['reel-1', 'reel-2'], message: ORGANIZE_FAILED_MESSAGE,
    })
    expect(organizeJobs().jobIds).toEqual([])
  })

  it('clears a standing failure once an attempt gets through', async () => {
    h.startOrganize.mockRejectedValue(new Error('network blip'))
    await planTrip()
    land(SUCCESS)
    await waitFor(() => { expect(organizeJobs().failure).not.toBeNull() }, { timeout: RETRY_WINDOW_MS })

    h.startOrganize.mockResolvedValue({ job_id: 'job-2' })
    await act(async () => { await Promise.resolve() })
    land(SUCCESS)
    await waitFor(() => { expect(organizeJobs().failure).toBeNull() })
  })

  it('neither retries nor reports the 409 a second tab earns', async () => {
    /* The server-side fence working, not a failure: those reels are being read right now by the
       job that won the race. Retrying earns the same 409, and telling the user their reels were
       not organized would be false. */
    h.startOrganize.mockRejectedValue(new ActiveOrganizeConflictError())
    await planTrip()
    land(SUCCESS)
    await waitFor(() => { expect(h.startOrganize).toHaveBeenCalledTimes(1) })

    await new Promise((r) => setTimeout(r, RETRY_WINDOW_MS / 2))
    expect(h.startOrganize).toHaveBeenCalledTimes(1)
    expect(organizeJobs().failure).toBeNull()

    // ...and the record is spent, because the work IS happening.
    land(SUCCESS)
    await act(async () => { await Promise.resolve() })
    expect(h.startOrganize).toHaveBeenCalledTimes(1)
  })

  it('does not start a second organize while the first request is still in flight', async () => {
    // The old fence was clearing the record before the call. Losing that fence to keep the record
    // would trade one defect for a worse one: two paid jobs for the same reels.
    const started = deferred<{ job_id: string }>()
    h.startOrganize.mockImplementation(() => started.promise)
    await planTrip()
    land(SUCCESS)
    await waitFor(() => { expect(h.startOrganize).toHaveBeenCalledTimes(1) })

    land({ type: 'heartbeat', elapsed_s: 91 })
    land(SUCCESS)
    await act(async () => { await Promise.resolve() })
    expect(h.startOrganize).toHaveBeenCalledTimes(1)

    started.resolve({ job_id: 'job-1' })
    await waitFor(() => { expect(organizeJobs().jobIds).toEqual(['job-1']) })
  })

  it('does not spend the NEXT run\'s record when this one\'s request finally lands', async () => {
    /* Found by fault injection: clearing `plannedReelsRef` on a successful organize without
       checking WHICH run the attempt was made for. A second generation can start while the first
       run's organize is still in flight — the lock came back the moment that run went terminal —
       and the clear then wiped the new run's record, so its reels were never organized at all.
       The same case is why the attempt is fenced on the RECORD and not on the component: a
       component-wide flag would have blocked the second organize outright. */
    const started = deferred<{ job_id: string }>()
    h.startOrganize.mockImplementationOnce(() => started.promise)
    const { plan } = await mountTools()
    await runPlan(plan, PLAN_ARGS)
    land(SUCCESS)
    await waitFor(() => { expect(h.startOrganize).toHaveBeenCalledTimes(1) })

    // The next run opens its own record while the first organize is still in flight.
    h.generateTrip.mockResolvedValue({ trip_id: 'trip-2' })
    h.captureSavedReel.mockResolvedValue({ saved_reel: { id: 'reel-B' } })
    h.startOrganize.mockResolvedValue({ job_id: 'job-2' })
    await runPlan(plan, { ...PLAN_ARGS, reel_urls: ['https://www.instagram.com/reel/Cxyz789/'] })

    started.resolve({ job_id: 'job-1' })
    await waitFor(() => { expect(organizeJobs().jobIds).toEqual(['job-1']) })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    land(SUCCESS)
    await waitFor(() => { expect(h.startOrganize).toHaveBeenCalledTimes(2) })
    expect(h.startOrganize).toHaveBeenLastCalledWith(['reel-B'], 'test-token')
  })
})

describe('captured reels belong to the run that captured them', () => {
  it('does not record a late capture from one run against the next', async () => {
    /* `saveReelForRun` awaited the save and then wrote into whatever record was open when it
       LANDED. Two runs in one session is all it takes: the first run's captures resolve after the
       second has opened its own record, and the second run's organize then pays to read reels it
       never planned from — while the first run's reels are still owed one. */
    const first = deferred<{ saved_reel: { id: string } }>()
    const second = deferred<{ saved_reel: { id: string } }>()
    const pending = [first, second]
    h.captureSavedReel.mockImplementation(() => pending.shift()!.promise)

    const { plan } = await mountTools()
    const runA = runPlan(plan, PLAN_ARGS)
    await waitFor(() => { expect(h.captureSavedReel).toHaveBeenCalledTimes(2) })

    // Run A dies, so its record is never spent — and the lock comes back for run B.
    land(FAILURE)
    h.generateTrip.mockResolvedValue({ trip_id: 'trip-2' })
    h.captureSavedReel.mockImplementation(() => Promise.resolve({ saved_reel: { id: 'reel-B' } }))
    await runPlan(plan, { ...PLAN_ARGS, reel_urls: ['https://www.instagram.com/reel/Cxyz789/'] })

    // ...and only NOW do run A's captures land, into a browser whose open record is run B's.
    first.resolve({ saved_reel: { id: 'reel-A1' } })
    second.resolve({ saved_reel: { id: 'reel-A2' } })
    await runA

    land(SUCCESS)
    await waitFor(() => { expect(h.startOrganize).toHaveBeenCalledTimes(1) })
    expect(h.startOrganize).toHaveBeenCalledWith(['reel-B'], 'test-token')
  })
})
