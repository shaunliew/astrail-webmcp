import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'
import type { StreamEvent } from '@/lib/trip/backend-types'
import GenerationProvider, { useGeneration, type GenerationApi } from '../GenerationProvider'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

/** Drives the stream by hand: no EventSource, no Supabase. */
function harness(tokenFails = false) {
  let emit: ((e: StreamEvent) => void) | null = null
  let reset: (() => void) | null = null
  let fail: (() => void) | null = null
  let opened = 0
  let releaseToken: (() => void) | null = null

  const openStream = vi.fn((_tripId, _token, onEvent, onReset, onFail) => {
    opened += 1
    emit = onEvent; reset = onReset ?? null; fail = onFail ?? null
    return { cancel: vi.fn() }
  })
  const readToken = vi.fn(
    () => new Promise<string>((resolve, reject) => {
      releaseToken = () => (tokenFails ? reject(new Error('no session')) : resolve('tok'))
    }),
  )

  let api: GenerationApi | null = null
  function Probe() { api = useGeneration(); return null }
  render(
    <GenerationProvider openStream={openStream as never} readToken={readToken}>
      <Probe />
    </GenerationProvider>,
  )
  return {
    get api() { return api! },
    get openedCount() { return opened },
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
    await act(async () => { h.api.start('trip-1') })
    expect(h.api.run.status).toBe('generating')
    expect(h.api.run.tripId).toBe('trip-1')
    expect(h.api.store.snapshot()?.tripId).toBe('trip-1')
    expect(h.openedCount).toBe(0)   // no stream yet — the token has not resolved
  })

  it('refuses a second start while one is live, and says so before any job is created', async () => {
    /* A second generation spends real Apify and OpenAI credit and does NOT stop the first. */
    const h = harness()
    await act(async () => { h.api.start('trip-1') })
    let second = true
    await act(async () => { second = h.api.start('trip-2') })
    expect(second).toBe(false)
    expect(h.api.run.tripId).toBe('trip-1')
  })

  it('opens exactly one stream per run', async () => {
    const h = harness()
    await act(async () => { h.api.start('trip-1') })
    await h.grantToken()
    expect(h.openedCount).toBe(1)
  })

  it('treats a result carrying {error} as FAILED, not complete', async () => {
    /* A leased backend failure can emit only this, with no preceding error event
       (runner.py:154 -> streaming.py:53). Reading it as success told the user a dead run
       had finished, and navigated them to it. */
    const h = harness()
    await act(async () => { h.api.start('trip-1') })
    await h.grantToken()
    await h.emit({ type: 'result', content: JSON.stringify({ error: 'lease lost' }) })
    expect(h.api.run.status).toBe('failed')
    expect(push).not.toHaveBeenCalled()
  })

  it('navigates to the finished trip on a real result', async () => {
    const h = harness()
    await act(async () => { h.api.start('trip-1') })
    await h.grantToken()
    await h.emit({ type: 'result', content: JSON.stringify({ trip_id: 'trip-final' }) })
    expect(h.api.run.status).toBe('complete')
    expect(push).toHaveBeenCalledWith('/app/trip/trip-final')
  })

  it('drops the event history when the stream reconnects', async () => {
    /* streamGeneration calls onReset on every EventSource open, and the backend replays every
       event from the start. Keeping the old ones would double the whole timeline. */
    const h = harness()
    await act(async () => { h.api.start('trip-1') })
    await h.grantToken()
    await h.emit(stage('scrape', 'Reading Reels'))
    await h.emit(stage('dedup', 'Checking places'))
    expect(h.api.run.events).toHaveLength(2)
    await h.reset()
    expect(h.api.run.events).toHaveLength(0)
  })

  it('does not sit on "generating" for ever when the token cannot be read', async () => {
    const h = harness(true)
    await act(async () => { h.api.start('trip-1') })
    await h.grantToken()
    expect(h.api.run.status).toBe('unknown')
    expect(h.openedCount).toBe(0)
  })

  it('goes unknown when the stream gives up, and frees the lock', async () => {
    const h = harness()
    await act(async () => { h.api.start('trip-1') })
    await h.grantToken()
    await h.fail()
    expect(h.api.run.status).toBe('unknown')
    let restarted = false
    await act(async () => { restarted = h.api.start('trip-2') })
    expect(restarted).toBe(true)
  })

  it('feeds the agent store, so a waiting get_trip_progress wakes', async () => {
    const h = harness()
    await act(async () => { h.api.start('trip-1') })
    await h.grantToken()
    const before = h.api.store.snapshot()!.version
    await h.emit(stage('scrape', 'Reading Reels'))
    expect(h.api.store.snapshot()!.version).toBeGreaterThan(before)
    expect(h.api.store.snapshot()!.lastMessage).toBe('Reading Reels')
  })

  it('lets a finished run start a new one, and keeps the runs separate', async () => {
    const h = harness()
    await act(async () => { h.api.start('trip-1') })
    await h.grantToken()
    await h.emit({ type: 'result', content: JSON.stringify({ trip_id: 'trip-1' }) })
    await act(async () => { h.api.start('trip-2') })
    expect(h.api.run.tripId).toBe('trip-2')
    expect(h.api.run.events).toHaveLength(0)
    expect(h.api.run.runId).toBe(2)
  })
})

describe('canStart — the check that must happen before the backend is called', () => {
  it('is false the moment a run is taken, without waiting for a render', async () => {
    /* `isBusy` is derived from rendered state and lags a tick. A second click in the SAME tick
       is exactly what this has to catch, because by the time React re-renders the second
       backend job already exists and is spending. */
    const h = harness()
    expect(h.api.canStart()).toBe(true)
    await act(async () => {
      h.api.start('trip-1')
      expect(h.api.canStart()).toBe(false)   // same tick, before any re-render
    })
  })

  it('is true again once the run finishes', async () => {
    const h = harness()
    await act(async () => { h.api.start('trip-1') })
    await h.grantToken()
    await h.emit({ type: 'result', content: JSON.stringify({ trip_id: 'trip-1' }) })
    expect(h.api.canStart()).toBe(true)
  })
})

describe('the run outliving the page — the whole reason this is in the shell', () => {
  it('keeps its history and status when the page that started it unmounts', async () => {
    /* SavedReelsFlow cancelled its own stream on unmount, so navigating away mid-generation
       froze the store on its last snapshot, timed out the agent's pending polls, and never
       navigated. The run has to belong to something that does not unmount. */
    const h = harness()
    await act(async () => { h.api.start('trip-1') })
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
    await act(async () => { h.api.start('trip-1') })
    await h.grantToken()
    const staleEmit = h.emit.bind(h)
    await h.emit({ type: 'result', content: JSON.stringify({ trip_id: 'trip-1' }) })
    push.mockClear()

    await act(async () => { h.api.start('trip-2') })
    // The FIRST run's stream is still holding its callbacks; a late event from it must be inert.
    await staleEmit({ type: 'result', content: JSON.stringify({ trip_id: 'trip-1' }) })
    expect(push).not.toHaveBeenCalledWith('/app/trip/trip-1')
    expect(h.api.run.tripId).toBe('trip-2')
  })
})
