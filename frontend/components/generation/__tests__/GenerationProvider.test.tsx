import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'
import type { StreamEvent } from '@/lib/trip/backend-types'
import GenerationProvider, {
  RESERVATION_DEADLINE_MS, TOKEN_TIMEOUT_MS, useGeneration, type GenerationApi,
} from '../GenerationProvider'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

/** Drives the stream by hand: no EventSource, no Supabase. */
function harness({ tokenFails = false, openThrows = false, cancelThrows = false } = {}) {
  let emit: ((e: StreamEvent) => void) | null = null
  let reset: (() => void) | null = null
  let fail: (() => void) | null = null
  let opened = 0
  let releaseToken: (() => void) | null = null
  const cancel = vi.fn()
  // Thrown ONCE. store.start() calls the previous run's cancel on its way in, which is how a
  // synchronous throw reaches begin(); throwing every time would make the test's own automatic
  // unmount an error too.
  let throwOnCancel = cancelThrows

  const openStream = vi.fn((_tripId, _token, onEvent, onReset, onFail) => {
    // `new EventSource(...)` throws synchronously on a bad URL, inside a detached async call.
    if (openThrows) throw new Error('EventSource refused')
    opened += 1
    emit = onEvent; reset = onReset ?? null; fail = onFail ?? null
    return {
      cancel: () => {
        cancel()
        // EventSource.close() is a real synchronous throw site on a stream the browser has
        // already torn down.
        if (throwOnCancel) { throwOnCancel = false; throw new Error('close failed') }
      },
    }
  })
  const readToken = vi.fn(
    () => new Promise<string>((resolve, reject) => {
      releaseToken = () => (tokenFails ? reject(new Error('no session')) : resolve('tok'))
    }),
  )

  let api: GenerationApi | null = null
  function Probe() { api = useGeneration(); return null }
  const view = render(
    <GenerationProvider openStream={openStream as never} readToken={readToken}>
      <Probe />
    </GenerationProvider>,
  )
  return {
    get api() { return api! },
    get openedCount() { return opened },
    get cancel() { return cancel },
    get readToken() { return readToken },
    unmount() { act(() => { view.unmount() }) },
    /** Non-destructive probe: reserve() TAKES the lock, so asking it a question in an assertion
     *  would answer the next one wrongly. This hands it straight back. */
    canReserve(): boolean {
      const reservation = api!.reserve()
      reservation?.release()
      return reservation !== null
    },
    /** reserve-then-commit in one step, for the tests that are not about the lock itself. */
    start(tripId: string): boolean {
      const reservation = api!.reserve()
      reservation?.begin(tripId)
      return reservation !== null
    },
    async grantToken() { await act(async () => { releaseToken?.(); await Promise.resolve(); await Promise.resolve() }) },
    async emit(e: StreamEvent) { await act(async () => { emit?.(e); await Promise.resolve() }) },
    async reset() { await act(async () => { reset?.(); await Promise.resolve() }) },
    async fail() { await act(async () => { fail?.(); await Promise.resolve() }) },
  }
}

const stage = (s: string, msg: string): StreamEvent => ({ type: 'stage', stage: s as never, msg })

describe('GenerationProvider', () => {
  beforeEach(() => { push.mockClear() })

  it('is answerable the instant start() returns, before the token resolves', async () => {
    /* The tool returns a trip_id in ~1s and the agent may poll immediately. Initializing after
       the token round-trip left a window where get_trip_progress reported no trip at all. */
    const h = harness()
    await act(async () => { h.start('trip-1') })
    expect(h.api.run.status).toBe('generating')
    expect(h.api.run.tripId).toBe('trip-1')
    expect(h.api.store.snapshot()?.tripId).toBe('trip-1')
    expect(h.openedCount).toBe(0)   // no stream yet — the token has not resolved
  })

  it('refuses a second start while one is live, and says so before any job is created', async () => {
    /* A second generation spends real Apify and OpenAI credit and does NOT stop the first. */
    const h = harness()
    await act(async () => { h.start('trip-1') })
    let second = true
    await act(async () => { second = h.start('trip-2') })
    expect(second).toBe(false)
    expect(h.api.run.tripId).toBe('trip-1')
  })

  it('opens exactly one stream per run', async () => {
    const h = harness()
    await act(async () => { h.start('trip-1') })
    await h.grantToken()
    expect(h.openedCount).toBe(1)
  })

  it('treats a result carrying {error} as FAILED, not complete', async () => {
    /* A leased backend failure can emit only this, with no preceding error event
       (runner.py:154 -> streaming.py:53). Reading it as success told the user a dead run
       had finished, and navigated them to it. */
    const h = harness()
    await act(async () => { h.start('trip-1') })
    await h.grantToken()
    await h.emit({ type: 'result', content: JSON.stringify({ error: 'lease lost' }) })
    expect(h.api.run.status).toBe('failed')
    // The AGENT-facing store has to agree. Fixing only the React run left get_trip_progress
    // announcing "the trip is ready" for a run the page was already showing as failed.
    expect(h.api.store.snapshot()!.status).toBe('failed')
    expect(push).not.toHaveBeenCalled()
  })

  it('does not navigate on a result it could not read', async () => {
    /* `complete` on an unreadable payload navigated to the id we happened to start with and told
       the agent the trip was ready — both asserted from a frame nothing could parse. Unreadable
       is not a verdict; `unknown` sends the user to look at the page instead. */
    const h = harness()
    await act(async () => { h.start('trip-1') })
    await h.grantToken()
    await h.emit({ type: 'result', content: 'not json at all' })
    expect(h.api.run.status).toBe('unknown')
    expect(h.api.store.snapshot()!.status).toBe('unknown')
    expect(push).not.toHaveBeenCalled()
  })

  it('treats a result whose error field is empty as FAILED — presence, not truthiness', async () => {
    // A failure frame that lost its message is still a failure frame.
    const h = harness()
    await act(async () => { h.start('trip-1') })
    await h.grantToken()
    await h.emit({ type: 'result', content: JSON.stringify({ error: '' }) })
    expect(h.api.run.status).toBe('failed')
    expect(h.api.store.snapshot()!.status).toBe('failed')
    expect(push).not.toHaveBeenCalled()
  })

  it('GUARD: an unreadable result is unknown on both views, navigates nowhere, and frees the lock', async () => {
    /* Declared a GUARD, not a reproduction: none of these three assertions was ever red. Every
       terminal result already freed the lock, and readResultVerdict already called a JSON array
       unreadable, so "frees the lock on a result it could not read" claimed coverage it did not
       have. What it does hold down is the ROUTING of that verdict through the provider: `[1,2,3]`
       parses, has no `.error`, and a presence test that forgot Array.isArray would read it as a
       finished trip — status complete, and a push to the id we happened to start with. */
    const h = harness()
    await act(async () => { h.start('trip-1') })
    await h.grantToken()
    await h.emit({ type: 'result', content: '[1,2,3]' })
    expect(h.api.run.status).toBe('unknown')
    expect(h.api.store.snapshot()!.status).toBe('unknown')
    expect(push).not.toHaveBeenCalled()
    expect(h.canReserve()).toBe(true)
  })

  it('navigates to the finished trip on a real result', async () => {
    const h = harness()
    await act(async () => { h.start('trip-1') })
    await h.grantToken()
    await h.emit({ type: 'result', content: JSON.stringify({ trip_id: 'trip-final' }) })
    expect(h.api.run.status).toBe('complete')
    expect(push).toHaveBeenCalledWith('/app/trip/trip-final')
  })

  it('drops the event history when the stream reconnects', async () => {
    /* streamGeneration calls onReset on every EventSource open, and the backend replays every
       event from the start. Keeping the old ones would double the whole timeline. */
    const h = harness()
    await act(async () => { h.start('trip-1') })
    await h.grantToken()
    await h.emit(stage('scrape', 'Reading Reels'))
    await h.emit(stage('dedup', 'Checking places'))
    expect(h.api.run.events).toHaveLength(2)
    await h.reset()
    expect(h.api.run.events).toHaveLength(0)
  })

  it('does not sit on "generating" for ever when the token cannot be read', async () => {
    const h = harness({ tokenFails: true })
    await act(async () => { h.start('trip-1') })
    await h.grantToken()
    expect(h.api.run.status).toBe('unknown')
    expect(h.openedCount).toBe(0)
  })

  it('goes unknown when the stream gives up, and frees the lock', async () => {
    const h = harness()
    await act(async () => { h.start('trip-1') })
    await h.grantToken()
    await h.fail()
    expect(h.api.run.status).toBe('unknown')
    let restarted = false
    await act(async () => { restarted = h.start('trip-2') })
    expect(restarted).toBe(true)
  })

  it('feeds the agent store, so a waiting get_trip_progress wakes', async () => {
    const h = harness()
    await act(async () => { h.start('trip-1') })
    await h.grantToken()
    const before = h.api.store.snapshot()!.version
    await h.emit(stage('scrape', 'Reading Reels'))
    expect(h.api.store.snapshot()!.version).toBeGreaterThan(before)
    expect(h.api.store.snapshot()!.lastMessage).toBe('Reading Reels')
  })

  it('lets a finished run start a new one, and keeps the runs separate', async () => {
    const h = harness()
    await act(async () => { h.start('trip-1') })
    await h.grantToken()
    await h.emit({ type: 'result', content: JSON.stringify({ trip_id: 'trip-1' }) })
    await act(async () => { h.start('trip-2') })
    expect(h.api.run.tripId).toBe('trip-2')
    expect(h.api.run.events).toHaveLength(0)
    expect(h.api.run.runId).toBe(2)
  })
})

describe('reserve — the lock is TAKEN before the backend is called, never merely read', () => {
  /* The bug this replaces: `canStart()` only READ the lock. Both callers check it, both then
     await a token and a POST, and only afterwards does one of them take the lock. In that window
     two real backend jobs exist, each spending Apify and OpenAI credit, and the loser's `start()`
     returning false was ignored by both call sites. Reserving is the whole fix: the lock is taken
     in the same synchronous step that decides whether this caller may proceed. */

  it('lets two racing callers create exactly ONE backend job', async () => {
    /* The real shape of both call sites: reserve, await the POST, commit. Run together in one
       tick, before either POST resolves — which is precisely the window check-then-act left open. */
    const h = harness()
    let releasePost: (tripId: string) => void = () => {}
    const post = vi.fn(() => new Promise<string>((resolve) => { releasePost = resolve }))

    const caller = async (tripId: string) => {
      const reservation = h.api.reserve()
      if (!reservation) return 'refused'
      try {
        reservation.begin(await post().then(() => tripId))
        return 'started'
      } catch {
        reservation.release()
        return 'errored'
      }
    }

    let first!: Promise<string>
    let second!: Promise<string>
    await act(async () => { first = caller('trip-agent'); second = caller('trip-manual') })

    // The refusal has to be settled BEFORE any money is spent, not after the POST comes back.
    expect(post).toHaveBeenCalledTimes(1)
    await act(async () => { releasePost('ok'); await Promise.resolve() })
    expect(await Promise.all([first, second])).toEqual(['started', 'refused'])
    expect(h.api.run.tripId).toBe('trip-agent')
  })

  it('hands the lock back when a reservation is released, so the next caller may proceed', async () => {
    // The POST failed: no backend job exists, and holding the lock would block every later
    // generation — manual and agent — for the rest of the session.
    const h = harness()
    const first = h.api.reserve()
    expect(first).not.toBeNull()
    expect(h.api.reserve()).toBeNull()          // held: the raw handle, not the probe
    act(() => { first!.release() })
    expect(h.canReserve()).toBe(true)
  })

  it('ignores a begin() on a reservation that was already released', async () => {
    /* Whichever of begin/release happens first settles the reservation. Without that, a caller
       that released on a failed POST and then hit a stray commit path would open a stream for a
       trip that does not exist, while the lock belonged to somebody else. */
    const h = harness()
    const reservation = h.api.reserve()!
    act(() => { reservation.release() })
    await act(async () => { reservation.begin('trip-ghost') })
    await h.grantToken()
    expect(h.openedCount).toBe(0)
    expect(h.api.run.tripId).toBeNull()
  })

  it('is reservable again once the run finishes', async () => {
    const h = harness()
    await act(async () => { h.start('trip-1') })
    await h.grantToken()
    await h.emit({ type: 'result', content: JSON.stringify({ trip_id: 'trip-1' }) })
    expect(h.canReserve()).toBe(true)
  })
})

describe('the lock — every exit path has to give it back', () => {
  /* busyRef is the only thing standing between the user and two paid generations, and it is held
     for the whole session. Any path that leaves it taken blocks EVERY later generation — manual
     and agent — with no way back short of a page reload. */

  it('releases the lock when opening the stream throws', async () => {
    // openStream is called inside a detached async function. A synchronous throw there (a bad
    // EventSource URL) became an unhandled rejection: no unlock, no status, no stream, for ever.
    const h = harness({ openThrows: true })
    await act(async () => { h.start('trip-1') })
    await h.grantToken()
    expect(h.api.run.status).toBe('unknown')
    expect(h.canReserve()).toBe(true)
    let restarted = false
    await act(async () => { restarted = h.start('trip-2') })
    expect(restarted).toBe(true)
  })

  it('releases the lock when starting the run throws synchronously', async () => {
    /* begin() settled the reservation BEFORE it attached the run, so a synchronous throw out of
       beginRun left the caller's own catch calling a release() that had already been disabled:
       no run on screen, no stream, and the lock held for the rest of the session. The throw site
       is real — store.start() cancels the previous stream on its way in, and EventSource.close()
       throws on a connection the browser has already torn down. */
    const h = harness({ cancelThrows: true })
    await act(async () => { h.start('trip-1') })
    await h.grantToken()                    // run 1 now has a live handle to cancel
    await h.fail()                          // frees the lock the honest way; the handle survives

    const reservation = h.api.reserve()!
    let thrown: unknown = null
    act(() => { try { reservation.begin('trip-2') } catch (err) { thrown = err } })
    // The error still reaches the caller — swallowing it would hide a genuine bug.
    expect(thrown).toBeInstanceOf(Error)
    // ...and the caller's catch calls release(), which begin() had already disabled. The lock has
    // to be back regardless of what that release does.
    act(() => { reservation.release() })
    expect(h.canReserve()).toBe(true)
  })

  it('releases the lock when the run is stopped through the exposed store', async () => {
    // `store` is public API. store.stop() cancelled the stream and left the lock taken.
    const h = harness()
    await act(async () => { h.start('trip-1') })
    await h.grantToken()
    await act(async () => { h.api.store.stop() })
    expect(h.canReserve()).toBe(true)
  })

  it('a stopped run stops SAYING it is generating, on both views', async () => {
    /* stop() gave the lock back and left both statuses on 'generating'. With the shell run as
       the page's first render branch that is not merely untidy: the wait screen stays up over a
       stream that has been cancelled, with nothing left to end it. */
    const h = harness()
    await act(async () => { h.start('trip-1') })
    await h.grantToken()
    await act(async () => { h.api.store.stop() })
    expect(h.api.run.status).toBe('unknown')
    expect(h.api.store.snapshot()!.status).toBe('unknown')
  })

  it('does not hand the lock back when a NEW run displaces the old stream', async () => {
    /* store.start() cancels the previous stream on its way in. That cancel must not release the
       lock the incoming run has just taken, or the unlock-on-cancel fix becomes a second-run hole
       wider than the leak it closed. */
    const h = harness()
    await act(async () => { h.start('trip-1') })
    await h.grantToken()
    await h.fail()                                  // frees the lock the honest way
    await act(async () => { h.start('trip-2') })  // this cancels run 1's stream
    expect(h.canReserve()).toBe(false)
    expect(h.api.run.tripId).toBe('trip-2')
  })
})

describe('unmounting the shell', () => {
  it('cancels the stream and silences every later callback', async () => {
    /* activeRef is a run number, not a mounted flag. Leaving /app left the EventSource open, and
       its callbacks could still push the user back into /app — after a sign-out, even. */
    const h = harness()
    await act(async () => { h.start('trip-1') })
    await h.grantToken()
    const stream = h.cancel

    h.unmount()
    expect(stream).toHaveBeenCalled()

    push.mockClear()
    await h.emit({ type: 'result', content: JSON.stringify({ trip_id: 'trip-final' }) })
    expect(push).not.toHaveBeenCalled()
  })

  it('refuses to RESERVE once the shell has gone', async () => {
    /* A stale api object outlives the provider: a page holding it in a detached async
       continuation — awaiting generateTrip while the user signs out — could still be told the
       lock was free, then POST, then open a stream nothing will ever cancel or render.
       The refusal has to happen at the reservation, before the money. */
    const h = harness()
    h.unmount()
    expect(h.canReserve()).toBe(false)
    expect(h.openedCount).toBe(0)
  })

  it('does not open a stream for a reservation the shell outlived', async () => {
    // Reserved while mounted, committed after the shell has gone — the window a page's own
    // in-flight POST sits in.
    const h = harness()
    const reservation = h.api.reserve()!
    h.unmount()
    await act(async () => { reservation.begin('trip-1') })
    await h.grantToken()
    expect(h.openedCount).toBe(0)
  })
})

describe('a token that never comes back', () => {
  /* readToken() runs AFTER the backend job has been created, so this is not a run that never
     started — it is a paid run with nothing watching it. A REJECTED token was already handled; a
     token that simply never settles was not, and it left the run on 'generating' for ever: wait
     screen up, lock held for the session, agent polling a stream that would never open. */
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('gives up on the run rather than holding the page and the lock for ever', async () => {
    const h = harness()                       // its token is never released
    await act(async () => { h.start('trip-1') })
    await act(async () => { await vi.advanceTimersByTimeAsync(TOKEN_TIMEOUT_MS + 1) })
    expect(h.api.run.status).toBe('unknown')
    expect(h.api.store.snapshot()!.status).toBe('unknown')
    expect(h.openedCount).toBe(0)
    expect(h.canReserve()).toBe(true)
  })

  it('does not fire on a token that arrives inside the window', async () => {
    const h = harness()
    await act(async () => { h.start('trip-1') })
    await act(async () => { await vi.advanceTimersByTimeAsync(TOKEN_TIMEOUT_MS - 1) })
    await h.grantToken()
    expect(h.api.run.status).toBe('generating')
    expect(h.openedCount).toBe(1)
  })
})

describe('a reservation nobody ever settles', () => {
  /* The pre-begin() half of the never-settling problem. TOKEN_TIMEOUT_MS bounds the token fetch
     INSIDE the provider, which runs after begin(); it cannot see the caller's own pre-commit work
     — a getAccessToken() and a POST — and that work happens while the reservation is held. A
     caller that hangs there calls neither begin() nor release(), so the lock stayed taken for the
     rest of the session and every later generation, agent and manual, was refused with "a trip is
     already being built" while nothing was being built at all. */
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('hands the lock back when the deadline passes with neither begin() nor release()', async () => {
    const h = harness()
    expect(h.api.reserve()).not.toBeNull()        // taken, and then simply abandoned
    await act(async () => { await vi.advanceTimersByTimeAsync(RESERVATION_DEADLINE_MS + 1) })
    expect(h.canReserve()).toBe(true)
  })

  it('does not open a stream for a begin() that arrives after the deadline', async () => {
    /* The reservation no longer holds the lock, so starting a run on it would be a run nothing
       owns — and a manual click in the same window would make it the second paid generation the
       whole reservation exists to prevent. */
    const h = harness()
    const stranded = h.api.reserve()!
    await act(async () => { await vi.advanceTimersByTimeAsync(RESERVATION_DEADLINE_MS + 1) })
    await act(async () => { stranded.begin('trip-late') })
    await h.grantToken()
    expect(h.openedCount).toBe(0)
  })

  it('says the late job is unknown rather than leaving both views silent about it', async () => {
    /* A begin() arriving late PROVES the POST returned: a real trip exists and nothing is
       watching it. Saying nothing is the dangerous answer — get_trip_progress would read an empty
       store and tell the agent "no trip is being generated, call plan_trip_from_reels to start
       one", which is an invitation to pay for the same trip twice. */
    const h = harness()
    const stranded = h.api.reserve()!
    await act(async () => { await vi.advanceTimersByTimeAsync(RESERVATION_DEADLINE_MS + 1) })
    await act(async () => { stranded.begin('trip-late') })
    expect(h.api.run.status).toBe('unknown')
    expect(h.api.run.tripId).toBe('trip-late')
    expect(h.api.store.snapshot()!.status).toBe('unknown')
    expect(h.api.store.snapshot()!.tripId).toBe('trip-late')
    // Orphaned, not running: it must not take the lock back on its way past.
    expect(h.canReserve()).toBe(true)
  })

  it('stays silent when a newer run has taken the freed lock since', async () => {
    /* The stale-write bug class this file already fixed once, arriving through the new path:
       reservation A expires, a real run B starts on the freed lock, and only then does A's late
       begin() land. Marking the orphan there would tell the agent it had lost contact with a run
       that is streaming perfectly well, and pull B's wait screen down with it. */
    const h = harness()
    const stranded = h.api.reserve()!
    await act(async () => { await vi.advanceTimersByTimeAsync(RESERVATION_DEADLINE_MS + 1) })
    await act(async () => { h.start('trip-live') })
    await h.grantToken()
    await act(async () => { stranded.begin('trip-late') })
    expect(h.api.run.tripId).toBe('trip-live')
    expect(h.api.run.status).toBe('generating')
    expect(h.api.store.snapshot()!.tripId).toBe('trip-live')
    expect(h.api.store.snapshot()!.status).toBe('generating')
  })

  it('writes nothing at all when the shell has gone', async () => {
    // Same rule the commit path already follows: a run nothing can render is not worth a snapshot
    // the agent will then read as news.
    const h = harness()
    const stranded = h.api.reserve()!
    await act(async () => { await vi.advanceTimersByTimeAsync(RESERVATION_DEADLINE_MS + 1) })
    h.unmount()
    await act(async () => { stranded.begin('trip-late') })
    expect(h.api.run.tripId).toBeNull()
    expect(h.api.store.snapshot()).toBeNull()
  })

  it('GUARD: a begin() inside the window is untouched by the deadline', async () => {
    // Green before this change too — it holds down the other side, that a deadline short enough
    // to be useful is still longer than a POST that simply took its time.
    const h = harness()
    const reservation = h.api.reserve()!
    await act(async () => { await vi.advanceTimersByTimeAsync(RESERVATION_DEADLINE_MS - 1) })
    await act(async () => { reservation.begin('trip-1') })
    await h.grantToken()
    expect(h.openedCount).toBe(1)
    expect(h.api.run.status).toBe('generating')
  })

  it('GUARD: the deadline stops counting once the run has begun', async () => {
    /* Green before this change too, because there was no clock at all. It is the regression that
       matters most about adding one: a timer that still fires past begin() would hand the lock
       back under a live 60-180s run and let a second paid generation start on top of it. Two
       things stop it — the clearTimeout in begin() and the `settled` check in the timer — so this
       goes red only when BOTH are gone. Verified by removing them together; removing either one
       alone leaves the invariant standing, which is the point of having both. */
    const h = harness()
    const reservation = h.api.reserve()!
    await act(async () => { reservation.begin('trip-1') })
    await h.grantToken()
    await act(async () => { await vi.advanceTimersByTimeAsync(RESERVATION_DEADLINE_MS + 1) })
    expect(h.api.run.status).toBe('generating')
    expect(h.canReserve()).toBe(false)
  })
})

describe('a stale run must not write into the live one', () => {
  it('cannot mark the newer run unknown when the old stream gives up', async () => {
    /* The store callbacks are not run-bound: they always write to whatever snapshot is current.
       A queued onFail from run 1 therefore landed on run 2 and told the agent it had lost
       contact with a run that was streaming normally. */
    const h = harness()
    await act(async () => { h.start('trip-1') })
    await h.grantToken()
    await h.emit({ type: 'result', content: JSON.stringify({ trip_id: 'trip-1' }) })

    await act(async () => { h.start('trip-2') })
    await h.fail()          // run 1's onFail, arriving late

    expect(h.api.store.snapshot()!.tripId).toBe('trip-2')
    expect(h.api.store.snapshot()!.status).toBe('generating')
    expect(h.api.run.status).toBe('generating')
  })
})

describe('the run outliving the page — the whole reason this is in the shell', () => {
  it('keeps its history and status when the page that started it unmounts', async () => {
    /* SavedReelsFlow cancelled its own stream on unmount, so navigating away mid-generation
       froze the store on its last snapshot, timed out the agent's pending polls, and never
       navigated. The run has to belong to something that does not unmount. */
    const h = harness()
    await act(async () => { h.start('trip-1') })
    await h.grantToken()
    await h.emit(stage('scrape', 'Reading Reels'))

    // A page unmounting is just a child leaving; the provider is the shell and stays.
    await h.emit(stage('dedup', 'Checking places'))
    expect(h.api.run.events).toHaveLength(2)
    expect(h.api.run.status).toBe('generating')
    expect(h.api.store.snapshot()!.status).toBe('generating')
  })

  it('a stale run cannot navigate once a newer one has started', async () => {
    const h = harness()
    await act(async () => { h.start('trip-1') })
    await h.grantToken()
    const staleEmit = h.emit.bind(h)
    await h.emit({ type: 'result', content: JSON.stringify({ trip_id: 'trip-1' }) })
    push.mockClear()

    await act(async () => { h.start('trip-2') })
    // The FIRST run's stream is still holding its callbacks; a late event from it must be inert.
    await staleEmit({ type: 'result', content: JSON.stringify({ trip_id: 'trip-1' }) })
    expect(push).not.toHaveBeenCalledWith('/app/trip/trip-1')
    expect(h.api.run.tripId).toBe('trip-2')
  })
})
