import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_VIEW_ROUTE,
  VIEW_INTENT_TIMEOUT_MS,
  requestViewIntent,
  resetViewIntent,
  subscribeViewIntent,
  takeViewIntent,
} from '../view-intent'

afterEach(() => {
  resetViewIntent()
  vi.useRealTimers()
})

/** Resolved yet? Asked without hanging the test on a promise that never settles. */
async function isSettled(p: Promise<void>): Promise<boolean> {
  return Promise.race([p.then(() => true), Promise.resolve().then(() => false)])
}

describe('the agent-to-page view intent', () => {
  it('names the route the app home lives on', () => {
    expect(AGENT_VIEW_ROUTE).toBe('/app')
  })

  it('hands the pending intent to the page exactly once', () => {
    const { intent } = requestViewIntent('saved-reels')
    expect(takeViewIntent()).toEqual(intent)
    // SINGLE USE. A back-button return remounts the page, which takes again — and a replayed
    // intent would yank the user out of whatever they came back to.
    expect(takeViewIntent()).toBeNull()
  })

  it('carries the reason the page was moved', () => {
    const { intent } = requestViewIntent('trip-generation')
    expect(intent.reason).toBe('trip-generation')
    expect(takeViewIntent()?.reason).toBe('trip-generation')
  })

  it('settles the waiter when the page takes the intent, not before', async () => {
    const { settled } = requestViewIntent('saved-reels')
    expect(await isSettled(settled)).toBe(false)
    takeViewIntent()
    expect(await isSettled(settled)).toBe(true)
  })

  it('tells a mounted page that an intent has arrived', () => {
    const seen = vi.fn()
    const unsubscribe = subscribeViewIntent(seen)
    requestViewIntent('saved-reels')
    expect(seen).toHaveBeenCalledTimes(1)
    unsubscribe()
    requestViewIntent('saved-reels')
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('supersedes an intent still waiting, rather than queueing behind it', async () => {
    const first = requestViewIntent('saved-reels')
    const second = requestViewIntent('trip-generation')
    // The first caller is released — it is never left awaiting a page move that now belongs to
    // somebody else — and only the newer intent is still on offer.
    expect(await isSettled(first.settled)).toBe(true)
    expect(takeViewIntent()).toEqual(second.intent)
  })

  it('gives up on its own when no page ever takes it', async () => {
    vi.useFakeTimers()
    const { settled } = requestViewIntent('saved-reels')
    vi.advanceTimersByTime(VIEW_INTENT_TIMEOUT_MS)
    expect(await isSettled(settled)).toBe(true)
    // ...and is GONE, not merely settled. An intent that outlived its own deadline and was then
    // applied by a page mounting minutes later is exactly the unasked-for navigation this
    // channel exists to avoid.
    expect(takeViewIntent()).toBeNull()
  })

  it('is inert with nothing pending', () => {
    expect(takeViewIntent()).toBeNull()
  })
})
