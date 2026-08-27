import { describe, it, expect } from 'vitest'
import { formatAppState, getAppStateTool, type AppStateSnapshot } from '../tools/app-state'

const base: AppStateSnapshot = {
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
