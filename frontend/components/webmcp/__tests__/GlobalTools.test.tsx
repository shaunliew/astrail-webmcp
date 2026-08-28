import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEffect } from 'react'
import { render, waitFor } from '@testing-library/react'
import type { Trip } from '@/lib/trip/backend-types'
import type { Entitlement } from '@/lib/entitlement'
import type { ToolSpec } from '@/lib/webmcp/types'

/**
 * What `get_app_state` actually says, assembled by the real component from real state.
 *
 * The snapshot builder lives inside GlobalTools, so the pure tests in
 * `lib/webmcp/__tests__/app-state.test.ts` can only check the FORMATTER — they take a snapshot
 * as input. Nothing checked the inferences that produce one, and that is exactly where the bug
 * lived: on an empty account the agent was told the user was blocked ("nothing saved yet — start
 * by saving a Reel") and answered by sending them to a form instead of offering to plan. The
 * precondition was true; the conclusion was not. `plan_trip_from_reels` takes raw pasted URLs and
 * the backend does no ownership check on `reel_urls`, so an empty library blocks nothing.
 *
 * These assertions read the tool's OUTPUT STRING, because that string is the whole interface the
 * agent has to this app's state.
 */

const h = vi.hoisted(() => ({
  pathname: '/app',
  specs: [] as ToolSpec[],
  listTrips: vi.fn<() => Promise<Trip[]>>(),
  listSavedReelCards: vi.fn<() => Promise<{ places: { name: string }[] }[]>>(),
  readEntitlement: vi.fn<() => Promise<Entitlement>>(),
}))

vi.mock('next/navigation', () => ({ usePathname: () => h.pathname }))

vi.mock('@/lib/trip/supabase-api', () => ({
  listTrips: () => h.listTrips(),
  getTrip: vi.fn(),
}))

vi.mock('@/lib/reels/api', () => ({
  listSavedReelCards: () => h.listSavedReelCards(),
  captureSavedReel: vi.fn(),
  startOrganize: vi.fn(),
}))

vi.mock('@/lib/supabase/session', () => ({ getAccessToken: async () => 'test-token' }))

// Spread the real module rather than replacing it: `ApiError` is a CLASS that
// lib/webmcp/tools/generation.ts branches on with `instanceof`, so a stubbed one would make
// every backend refusal look like an unrelated error.
vi.mock('@/lib/trip/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/trip/api')>(),
  addTripPlace: vi.fn(), deleteTripPlace: vi.fn(), editTripDates: vi.fn(),
  editTripPlace: vi.fn(), generateTrip: vi.fn(), replanTrip: vi.fn(),
}))

// Only the own-row read is stubbed; TRIAL_LIFETIME_LIMIT stays the real constant, so a test that
// pinned the wrong number would fail against the value the backend actually enforces.
vi.mock('@/lib/entitlement', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/entitlement')>(),
  readEntitlement: () => h.readEntitlement(),
}))

// Only the two fields GlobalTools reads. The generation controller is another task's file and is
// mid-review; mocking the hook keeps this test off it entirely.
vi.mock('@/components/generation/GenerationProvider', async () => {
  const { createGenerationStore } = await import('@/lib/webmcp/generation')
  const store = createGenerationStore()
  return { useGeneration: () => ({ store, reserve: () => null }) }
})

// The seam that hands us the finished specs, built by the real globalTools() from the real reader.
vi.mock('../RegisterTools', () => ({
  RegisterTools: ({ specs }: { specs: ToolSpec[] }) => {
    h.specs = specs
    return null
  },
}))

const { WebMcpRegistryProvider, useWebMcpRegistry } = await import('../WebMcpRegistry')
const { default: GlobalTools } = await import('../GlobalTools')

/** Renders the component, waits for both loads to land, and returns what the agent would read. */
async function appState(opts: {
  trips?: Trip[]
  reels?: { places: { name: string }[] }[]
  path?: string
} = {}): Promise<string> {
  h.pathname = opts.path ?? '/app'
  h.listTrips.mockResolvedValue(opts.trips ?? [])
  h.listSavedReelCards.mockResolvedValue(opts.reels ?? [])
  render(<WebMcpRegistryProvider><GlobalTools /></WebMcpRegistryProvider>)
  const read = async () => {
    const spec = h.specs.find((s) => s.name === 'get_app_state')
    if (!spec) throw new Error('get_app_state was never built')
    return String(await spec.execute({}))
  }
  // Both fetches resolve before the counts are real; until then every number reads "unknown".
  await waitFor(async () => { expect(await read()).not.toContain('could not be loaded') })
  return read()
}

beforeEach(() => {
  h.specs = []
  h.listTrips.mockReset()
  h.listSavedReelCards.mockReset()
  h.readEntitlement.mockReset()
  h.readEntitlement.mockResolvedValue({ plan: 'trial', lifetimeTripCount: 0, seatRequestedAt: null })
  cardsShown.length = 0
})

describe('get_app_state, assembled from live state', () => {
  it('reports NOTHING blocked on an empty account — saving is not a prerequisite for planning', async () => {
    // The captured defect: with no reels and no trips the agent was handed a blocker and
    // dutifully told the user to go paste links into a form. plan_trip_from_reels needs
    // reel_urls + dates and nothing else; an empty library is just an empty library.
    const out = await appState({ trips: [], reels: [] })
    // Anchored: the buggy line "Blocked:    nothing saved yet — …" also *contains* "nothing".
    expect(out).toMatch(/^Blocked: {4}nothing$/m)
    expect(out).not.toContain('nothing saved yet')
    expect(out).not.toMatch(/start by saving/i)
  })

  it('still states the empty library as a plain fact rather than hiding it', async () => {
    // Removing the false blocker must not remove the true count. Zero is a fact the agent needs.
    const out = await appState({ trips: [], reels: [] })
    expect(out).toContain('0 saved reels')
    expect(out).toContain('0 verified places')
  })

  it('tells the agent the reels do NOT have to be saved first', async () => {
    // Without this the next-step line repeated the same false prerequisite the blocker did:
    // "plan a new trip from saved Instagram Reels".
    const out = await appState({ trips: [], reels: [] })
    expect(out).toContain('plan_trip_from_reels')
    expect(out).toContain('saving them first is optional')
    expect(out).not.toContain('from saved Instagram Reels')
  })

  it('offers saving without implying the user already has some saved', async () => {
    // "save more Instagram Reels" is simply false on an empty account, and the agent reads it as
    // a fact about the library rather than as the name of an action — the same class of defect
    // as the blocker above, one line down.
    const out = await appState({ trips: [], reels: [] })
    expect(out).toContain('save Instagram Reels to plan from later')
    expect(out).not.toContain('save more')
  })

  it('offers saving in exactly the same words once the library is not empty', async () => {
    // One label, no branch: the wording has to be true in both states rather than correct in one.
    const out = await appState({ trips: [], reels: [{ places: [{ name: 'Shibuya Crossing' }] }] })
    expect(out).toContain('save Instagram Reels to plan from later')
    expect(out).not.toContain('save more')
  })

  it('names what the reels have to be, so the agent can ask for it in one turn', async () => {
    const out = await appState({ trips: [], reels: [] })
    expect(out).toContain('1-5 reel links and dates, YYYY-MM-DD')
  })

  it('describes /app by what can happen there, not by what is stored there', async () => {
    // An inventory label ("Saved Reels — where trips start") invites an inventory answer, which
    // is what the agent gave: a tour of the nav instead of an offer to act.
    const out = await appState({ path: '/app' })
    expect(out).toContain('You are on: Saved Reels — plan a trip here, or save Reels to plan from later')
    expect(out).not.toContain('where trips start')
  })

  it('leaves the other route labels alone', async () => {
    expect(await appState({ path: '/app/trips' })).toContain('You are on: your saved trips')
  })
})

/**
 * The other half of the same defect, one tool along.
 *
 * `plan_trip_from_reels` had no entitlement dependency at all: it was registered unconditionally,
 * so an exhausted account got the approval card, the user approved the spend, and only THEN did
 * the backend reject it. The manual flow never does that — useEntitlement marks the account
 * exhausted and TrialExhaustedCard renders INSTEAD of a Generate button, before anything is spent
 * and before any consent is taken. These tests read the tool's own return value, because that
 * string is the whole interface the agent has to the refusal.
 */

/** Records every approval card the tools ask for, and answers it so nothing hangs. */
const cardsShown: string[] = []

function AutoDecline() {
  const { pending } = useWebMcpRegistry()
  useEffect(() => {
    if (!pending) return
    cardsShown.push(pending.summary)
    pending.resolve(false)
  }, [pending])
  return null
}

const PLAN_ARGS = {
  reel_urls: ['https://www.instagram.com/reel/Cabc123/'],
  start_date: '2026-03-03',
  end_date: '2026-03-07',
}

/** Mounts the shell and hands back plan_trip_from_reels exactly as the agent would call it. */
async function planTripTool(): Promise<ToolSpec> {
  h.listTrips.mockResolvedValue([])
  h.listSavedReelCards.mockResolvedValue([])
  render(
    <WebMcpRegistryProvider>
      <GlobalTools />
      <AutoDecline />
    </WebMcpRegistryProvider>,
  )
  let spec: ToolSpec | undefined
  await waitFor(() => {
    spec = h.specs.find((s) => s.name === 'plan_trip_from_reels')
    expect(spec, 'plan_trip_from_reels was never built').toBeTruthy()
  })
  return spec!
}

describe('plan_trip_from_reels, gated on the account the browser can actually read', () => {
  it('refuses BEFORE the approval card when the free trial is already spent', async () => {
    h.readEntitlement.mockResolvedValue({ plan: 'trial', lifetimeTripCount: 1, seatRequestedAt: null })
    const out = String(await (await planTripTool()).execute(PLAN_ARGS))
    // The whole point: consent is never taken for a spend that cannot happen.
    expect(cardsShown).toHaveLength(0)
    expect(out).toMatch(/free trial/i)
    expect(out).toMatch(/does not reset/i)
    expect(out).toMatch(/seat/i)
  })

  it('still asks a BETA account, however many trips it has already planned', async () => {
    /* The trial limit is a fact about the trial PLAN, not about a raw count. A seat holder is on
       the daily quota, which lives in user_daily_usage and the browser never reads — refusing
       them on a lifetime count would be a guess, and one that locks out exactly the accounts we
       handed a seat to. */
    h.readEntitlement.mockResolvedValue({ plan: 'beta', lifetimeTripCount: 12, seatRequestedAt: null })
    const run = (await planTripTool()).execute(PLAN_ARGS)
    await waitFor(() => { expect(cardsShown).toHaveLength(1) })
    expect(String(await run)).toMatch(/declined/i)
  })

  it('still asks when the entitlement read fails outright', async () => {
    // Never a confident zero on data we failed to read. A downed advisory read must not refuse a
    // trip the backend would have allowed; the RPC is the authority and gets to say no itself.
    h.readEntitlement.mockRejectedValue(new Error('offline'))
    const run = (await planTripTool()).execute(PLAN_ARGS)
    await waitFor(() => { expect(cardsShown).toHaveLength(1) })
    expect(String(await run)).toMatch(/declined/i)
  })

  it('reads the entitlement at CALL time, not once at mount', async () => {
    /* A mount-time snapshot goes stale in the one direction that costs the user something: a
       server-side refund after a failed run frees the trial again (complete_trip_run decrements
       lifetime_trip_count), and a cached "exhausted" would then refuse a generation the backend
       would have allowed. GlobalTools is mounted for the whole session, so this matters. */
    h.readEntitlement.mockResolvedValue({ plan: 'trial', lifetimeTripCount: 1, seatRequestedAt: null })
    const spec = await planTripTool()
    expect(String(await spec.execute(PLAN_ARGS))).toMatch(/free trial/i)

    // The refund lands between the two calls; the second must see it.
    h.readEntitlement.mockResolvedValue({ plan: 'trial', lifetimeTripCount: 0, seatRequestedAt: null })
    const run = spec.execute(PLAN_ARGS)
    await waitFor(() => { expect(cardsShown).toHaveLength(1) })
    expect(String(await run)).toMatch(/declined/i)
  })
})
