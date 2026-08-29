import { describe, it, expect } from 'vitest'
import { formatAppState, getAppStateTool, type AppStateSnapshot } from '../tools/app-state'

const base: AppStateSnapshot = {
  account: 'signed_in',
  where: 'Saved Reels — where trips start',
  savedReels: 6,
  verifiedPlaces: 17,
  trips: { total: 23, complete: 23, unfinished: 0 },
  nextSteps: [{ label: 'plan a new trip', tool: 'plan_trip_from_reels', needs: 'dates' }],
  blocked: [],
}

describe('formatAppState', () => {
  it('reports known counts plainly', () => {
    const out = formatAppState(base)
    expect(out).toContain('6 saved reels')
    expect(out).toContain('17 verified places')
    expect(out).toContain('23 trips')
    expect(out).not.toContain('unknown')
  })

  it('says "unknown" — never zero — when a count could not be loaded', () => {
    // The bug this guards: a hardcoded 0 made the agent tell a user with a full library
    // that they had no saved reels, and then advise them to start by pasting one.
    const out = formatAppState({ ...base, savedReels: null, verifiedPlaces: null })
    expect(out).toContain('an unknown number of saved reels')
    expect(out).not.toMatch(/\b0 saved reels\b/)
  })

  it('warns the agent explicitly not to claim the user has none', () => {
    const out = formatAppState({ ...base, savedReels: null })
    expect(out).toContain('could not be loaded')
    expect(out).toContain('do not tell the user they have none')
  })

  it('handles unknown trips too', () => {
    const out = formatAppState({ ...base, trips: null })
    expect(out).toContain('an unknown number of trips')
  })

  it('adds no warning when every count is known', () => {
    expect(formatAppState(base)).not.toContain('could not be loaded')
  })

  it('reports a genuine zero as zero', () => {
    // "Unknown" must not swallow a real, loaded zero — that is the opposite error.
    const out = formatAppState({ ...base, savedReels: 0, verifiedPlaces: 0 })
    expect(out).toContain('0 saved reels')
    expect(out).not.toContain('could not be loaded')
  })

  it('lists next steps with the tool that performs each one', () => {
    const out = formatAppState(base)
    expect(out).toContain('plan a new trip → plan_trip_from_reels (needs dates)')
  })

  it('says "nothing" rather than omitting the blocked line', () => {
    expect(formatAppState(base)).toContain('Blocked:    nothing')
  })
})

/**
 * The signed-out answer, on the one page a visitor can open without an account.
 *
 * `get_app_state` is the tool this whole integration was justified by — real users said it was
 * "unclear how to navigate the website" — so "what can I do here?" is the likeliest first move on
 * the free path. Registering it there and letting it answer in terms of an account the visitor
 * does not have would reproduce the exact failure it was built to prevent.
 *
 * The counts are the delicate part. `null` already means "we tried and could not load this", and
 * the formatter answers it with a note telling the agent not to claim the user has none. Signed
 * out, nothing was tried and nothing failed — the question does not apply — so the snapshot says
 * so in a THIRD state rather than borrowing `null`'s meaning for a second job.
 */
describe('formatAppState, signed out on the public sample trail', () => {
  const publicSample: AppStateSnapshot = {
    account: 'signed_out',
    where: 'the public sample trail',
    nextSteps: [{ label: 'read the whole trail', tool: 'get_itinerary' }],
    blocked: ['saving Reels, planning a trip and editing an itinerary all need an account'],
  }

  it('makes no claim at all about the visitor\'s own reels, places or trips', () => {
    // Not "0", which asserts they own nothing — they may have an account and simply not be
    // signed in — and not "an unknown number", which asserts we tried and failed.
    const out = formatAppState(publicSample)
    expect(out).not.toMatch(/saved reels/)
    expect(out).not.toMatch(/verified places/)
    expect(out).not.toMatch(/unknown number/)
    expect(out).not.toMatch(/\d+ trips/)
  })

  it('does not emit the could-not-load note, because nothing failed to load', () => {
    /* The note is a repair for a FAILED read. Printing it here would send the agent hedging
       about a library that is not there to hedge about, which is the same class of false
       statement the note exists to prevent, pointed the other way. */
    const out = formatAppState(publicSample)
    expect(out).not.toContain('could not be loaded')
    expect(out).not.toContain('do not tell the user they have none')
  })

  it('tells the agent outright that it knows nothing about this person', () => {
    // Silence is not enough: an agent that simply sees no counts may still guess at them.
    expect(formatAppState(publicSample)).toMatch(/Account: +none/)
    expect(formatAppState(publicSample)).toMatch(/signed out/i)
  })

  it('still lists the next steps and the blockers', () => {
    const out = formatAppState(publicSample)
    expect(out).toContain('read the whole trail → get_itinerary')
    expect(out).toContain('need an account')
  })

  it('leaves the signed-in shape completely alone', () => {
    // The third state must not cost the other two anything.
    const out = formatAppState({ ...base, savedReels: null })
    expect(out).toContain('an unknown number of saved reels')
    expect(out).toContain('do not tell the user they have none')
    expect(out).not.toMatch(/Account: +none/)
  })
})

describe('get_app_state tool', () => {
  it('reads through the function at call time, never a captured snapshot', async () => {
    // useWebMCP keeps execute stable by design, so a value captured at registration would be
    // first-render data forever. The reader indirection is what keeps this honest.
    let current: AppStateSnapshot = { ...base, savedReels: 1 }
    const spec = getAppStateTool(() => current)
    expect(String(await spec.execute({}))).toContain('1 saved reels')
    current = { ...base, savedReels: 9 }
    expect(String(await spec.execute({}))).toContain('9 saved reels')
  })

  it('is declared read-only and untrusted', () => {
    const spec = getAppStateTool(() => base)
    expect(spec.annotations?.readOnlyHint).toBe(true)
    expect(spec.annotations?.untrustedContentHint).toBe(true)
  })
})
