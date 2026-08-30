import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEffect } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import type { Trip, TripBundle } from '@/lib/trip/backend-types'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
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
  /** 'pending' models the real gap between mount and the session read landing. */
  session: 'yes' as 'yes' | 'no' | 'pending',
  listTrips: vi.fn<() => Promise<Trip[]>>(),
  listSavedReelCards: vi.fn<() => Promise<{ places: { name: string }[] }[]>>(),
  readEntitlement: vi.fn<() => Promise<Entitlement>>(),
}))

// GlobalTools navigates from inside a tool call (the page follows the agent), so the router
// has to exist here even though nothing in this file drives one.
vi.mock('next/navigation', () => ({ usePathname: () => h.pathname, useRouter: () => ({ push: vi.fn() }) }))

vi.mock('@/lib/trip/supabase-api', () => ({
  listTrips: () => h.listTrips(),
  getTrip: vi.fn(),
}))

vi.mock('@/lib/reels/api', () => ({
  listSavedReelCards: () => h.listSavedReelCards(),
  captureSavedReel: vi.fn(),
  startOrganize: vi.fn(),
}))

/* Controllable, because the tool LIST now depends on it. `getAccessToken` is the same call every
   withheld tool makes, so a test that lies here would be testing a gate the tools do not share. */
vi.mock('@/lib/supabase/session', () => ({
  getAccessToken: () => {
    if (h.session === 'no') return Promise.reject(new Error('Not signed in'))
    if (h.session === 'pending') return new Promise<string>(() => {})
    return Promise.resolve('test-token')
  },
}))

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

// The mocked edit endpoints, so a refusal can be proved by the call that never happened.
const { deleteTripPlace, editTripPlace } = await import('@/lib/trip/api')

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
  h.session = 'yes'
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

/**
 * The sample trail, `/app/trip/demo` — read tools see it, write tools never do.
 *
 * `TripTools` deliberately withholds a read-only bundle from `registry.openTrip`, because
 * `resolveBundle` reads that ref whenever no trip_id is passed and all five edit tools resolve
 * their target through it: publishing a fixture there would point `move_place` and friends at
 * `trip_tokyo_demo`, which is not a row, and four of them raise an approval card BEFORE the write
 * fails — asking the user to authorise a change that cannot happen. The cost was that
 * `get_itinerary` and `get_place_evidence` share that one seam, so only three of the five tools a
 * trip page offers actually answered on the flagship demo.
 *
 * The fix is here rather than in TripTools because this is where the two halves are built: the
 * read tools get a reader that falls back to the sample ON THAT ROUTE, the write tools keep the
 * reader that only ever sees a real open trip. The refusal therefore happens at the SEAM, not at
 * a registration flag — nothing about it depends on when an effect ran.
 */
const SAMPLE_PATH = '/app/trip/demo'

/** Mounts the shell on a route and hands back one tool, ready to call. Signed IN, per the
 *  beforeEach default — which is the configuration where the write tools are offered on this
 *  route at all, and therefore the one where the reader's refusal has to hold. */
async function toolOn(path: string, name: string): Promise<ToolSpec> {
  h.pathname = path
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
    spec = h.specs.find((s) => s.name === name)
    expect(spec, `${name} was never built`).toBeTruthy()
  })
  return spec!
}

describe('the sample trail is readable without a sign-in', () => {
  it('answers get_itinerary from the sample instead of asking which trip', async () => {
    const out = String(await (await toolOn(SAMPLE_PATH, 'get_itinerary')).execute({}))
    expect(out).not.toContain('Which trip?')
    expect(out).toContain('Akasaka Station')
  })

  it('hands get_place_evidence the real source Reel for a stop on it', async () => {
    // The whole point of the page. A judge asking "why is stop 1 here?" gets the caption and a
    // Reel they can open, with no account and nothing spent.
    const out = String(await (await toolOn(SAMPLE_PATH, 'get_place_evidence')).execute({ place: '1' }))
    expect(out).toMatch(/reel: https:\/\/www\.instagram\.com\/reel\//)
  })

  it('does not leak the sample onto any other route', async () => {
    // The sample belongs to the page showing it. Answering "what's on day 2" with someone
    // else's demo trip, on a route displaying the user's own trips, is a worse bug than silence.
    const out = String(await (await toolOn('/app/trips', 'get_itinerary')).execute({}))
    expect(out).toContain('Which trip?')
  })
})

describe('the sample trail is NOT writable', () => {
  it('refuses an edit against it without ever raising an approval card', async () => {
    // `trip_tokyo_demo` has no row. move_place applies without a card, but add/remove/dates/
    // replan ask first — so a write tool that could see the sample would take consent for a
    // change the backend cannot make.
    const out = JSON.parse(String(await (await toolOn(SAMPLE_PATH, 'move_place')).execute({ place: '1', to_day: 3 })))
    expect(out.result).toBe('Which trip? Call list_trips and pass its trip_id.')
    // And it says so as an OUTCOME, not only in the sentence: the activity rail read a returned
    // string as a completed move and recorded `MOVED · can't undo` for calls like this one.
    expect(out.outcome).toBe('failed')
    expect(cardsShown).toHaveLength(0)
    expect(editTripPlace).not.toHaveBeenCalled()
  })

  it('refuses even when the agent names the sample trip outright', async () => {
    // Withholding it from the default target is not enough: `get_itinerary` prints no trip id,
    // but an agent that has seen one will pass it back.
    const out = String(
      await (await toolOn(SAMPLE_PATH, 'remove_place')).execute({ place: '1', trip_id: 'trip_tokyo_demo' }),
    )
    expect(out).toContain('No trip with id')
    expect(cardsShown).toHaveLength(0)
    expect(deleteTripPlace).not.toHaveBeenCalled()
  })
})

/**
 * What the ONE page a judge can open without an account advertises.
 *
 * `/app/trip/demo` is allowlisted for signed-out visitors by exact match in middleware, and
 * GlobalTools registers from the /app layout with no session gate of any kind — so the address-bar
 * list offered sixteen tools of which five answered. Eleven of the other thirteen need a JWT
 * (`list_trips` and `list_saved_reels` read RLS-guarded rows; `save_reels`, `plan_trip_from_reels`
 * and the five edit tools call `getAccessToken`), and the last two, `get_app_state` and
 * `get_trip_progress`, do not throw but answer by naming those same tools as the next step — the
 * same defect one turn later. The agent was being invited to fail in front of a judge.
 *
 * These assertions read the NAMES handed to RegisterTools, because that array is what reaches
 * `document.modelContext` and is therefore what the browser lists.
 */

/** Registered here AND answering on the sample trail with no session. */
const PUBLIC_ANSWERS = ['get_app_state', 'get_itinerary', 'get_place_evidence']

/** Registered here and failing, or pointing at something that fails, with no session. */
const NEEDS_A_SESSION = [
  'list_trips', 'list_saved_reels', 'save_reels', 'plan_trip_from_reels',
  'get_trip_progress', 'add_place', 'move_place', 'remove_place', 'replan_trip', 'set_trip_dates',
]

/* A FRESH element every time, never a shared constant. React bails out of reconciliation when
   an element is referentially identical to the previous one, so a `rerender(SHELL)` with a hoisted
   element is a no-op — the navigation tests below silently tested nothing. */
const shell = () => (
  <WebMcpRegistryProvider>
    <GlobalTools />
  </WebMcpRegistryProvider>
)

/** Lets the mount-time session read land. */
const settle = () => act(async () => {})

/** Mounts the shell on a route and hands back what the browser is being offered, live. */
function shellOn(path: string, opts: { session?: 'yes' | 'no' | 'pending' } = {}) {
  h.pathname = path
  h.session = opts.session ?? 'yes'
  // What a signed-out visitor actually gets from both of these. The gate does not read them — it
  // reads the session — but feeding them success would be describing a page that does not exist.
  if (h.session === 'yes') {
    h.listTrips.mockResolvedValue([])
    h.listSavedReelCards.mockResolvedValue([])
  } else {
    h.listTrips.mockRejectedValue(new Error('Not signed in'))
    h.listSavedReelCards.mockRejectedValue(new Error('Not signed in'))
  }
  const view = render(shell())
  return {
    offered: () => h.specs.map((s) => s.name).sort(),
    goTo: async (next: string) => {
      h.pathname = next
      await act(async () => { view.rerender(shell()) })
    },
  }
}

describe('the public sample trail advertises only what answers there', () => {
  it('offers exactly the two global tools that work with no session', async () => {
    const shell = shellOn(SAMPLE_PATH, { session: 'no' })
    await settle()
    expect(shell.offered()).toEqual([...PUBLIC_ANSWERS].sort())
  })

  it('advertises none of the eleven that need a session', async () => {
    const shell = shellOn(SAMPLE_PATH, { session: 'no' })
    await settle()
    for (const name of NEEDS_A_SESSION) expect(shell.offered()).not.toContain(name)
  })

  it('answers get_itinerary from the sample with no session at all', async () => {
    // Registered AND answering, without a credential — the whole claim this page makes.
    const shell = shellOn(SAMPLE_PATH, { session: 'no' })
    await settle()
    const spec = h.specs.find((s) => s.name === 'get_itinerary')
    expect(spec, 'get_itinerary was withheld from the page whose point it is').toBeTruthy()
    expect(String(await spec!.execute({}))).toContain('Akasaka Station')
  })

  it('fails toward the small list while the session read is still in flight', async () => {
    /* The direction matters more than the window. Failing the other way would show a judge
       sixteen tools and then take eleven away — advertising failures during exactly the window a
       freshly loaded agent reads the list. This way the list only ever grows. */
    const shell = shellOn(SAMPLE_PATH, { session: 'pending' })
    await settle()
    expect(shell.offered()).toEqual([...PUBLIC_ANSWERS].sort())
  })

  it('grows to the full set for a signed-in user who opens the sample trail', async () => {
    // Session is the truthful signal: a JWT makes all thirteen work here, demo route or not.
    const shell = shellOn(SAMPLE_PATH, { session: 'yes' })
    await waitFor(() => { expect(shell.offered()).toHaveLength(13) })
    expect(shell.offered()).toEqual([...PUBLIC_ANSWERS, ...NEEDS_A_SESSION].sort())
  })

  it('leaves every other route alone, session or not', async () => {
    /* Deliberately route-scoped rather than a bare session check. Middleware redirects a
       signed-out visitor off every /app path but this one, so a global gate would buy nothing
       here and cost every signed-in user a churned tool list on every page load. */
    const shell = shellOn('/app', { session: 'no' })
    await settle()
    expect(shell.offered()).toHaveLength(13)
  })
})

describe('navigating does not leave a stale list', () => {
  it('re-reads the session on the way back, so signing in is not undone by returning', async () => {
    /* The judge signs in from the sample trail and comes back to it. A session read taken once at
       mount would still say "signed out" and hand them the two-tool list on a page where all
       thirteen now work. */
    const shell = shellOn(SAMPLE_PATH, { session: 'no' })
    await settle()
    expect(shell.offered()).toHaveLength(3)

    h.session = 'yes'
    await shell.goTo('/app')
    await waitFor(() => { expect(shell.offered()).toHaveLength(13) })
    await shell.goTo(SAMPLE_PATH)
    await waitFor(() => { expect(shell.offered()).toHaveLength(13) })
  })

  it('offers the same names on the sample trail before and after a round trip', async () => {
    /* Names and schemas are observed by the browser and must not churn across a client-side
       navigation. Leaving and returning has to land on the same list, not a permutation of it. */
    const shell = shellOn(SAMPLE_PATH, { session: 'no' })
    await settle()
    const first = shell.offered()
    await shell.goTo('/app')
    await settle()
    expect(shell.offered()).toHaveLength(13)
    await shell.goTo(SAMPLE_PATH)
    await settle()
    expect(shell.offered()).toEqual(first)
  })
})

describe('the sample trail is not writable, at either layer', () => {
  it('does not even advertise a write tool to a signed-out visitor', async () => {
    /* A SECOND, independent layer. The two tests above prove the READER refuses the fixture even
       when the tool is registered, which is the guarantee and does not depend on this; this adds
       that a visitor with no session is never offered the tool to try. Delete either half and the
       other still holds. */
    const shell = shellOn(SAMPLE_PATH, { session: 'no' })
    await settle()
    for (const w of ['move_place', 'remove_place', 'add_place', 'set_trip_dates', 'replan_trip']) {
      expect(shell.offered()).not.toContain(w)
    }
  })
})

/**
 * What `get_app_state` SAYS to a visitor with no account — the other half of the same honesty.
 *
 * Registering it signed-out is only an improvement if its answer is true there. Left alone it
 * reported an account the visitor does not have ("an unknown number of saved reels"), warned that
 * counts could not be loaded when nothing had failed to load, and recommended
 * `plan_trip_from_reels` and `save_reels` as next steps — tools that are no longer even offered on
 * that page. That is the tool's own founding defect, reproduced on the free path: a stuck visitor
 * asking "what can I do here?" and being pointed at things that cannot work.
 */
async function appStateOn(path: string, session: 'yes' | 'no'): Promise<string> {
  const shell = shellOn(path, { session })
  await waitFor(() => { expect(shell.offered()).toContain('get_app_state') })
  /* `get_app_state` registers with or without a session — it is in PUBLIC_ANSWERS — so its
     presence proves the shell mounted and NOTHING about whether the session landed. On the
     sample path that gap is answerable: the signed-out branch returns a complete, plausible
     answer, so a `session: 'yes'` case that executes too early gets the signed-OUT reply and
     fails on wording, looking like a copy regression. Seen once in a full parallel run and not
     on the next; a flake this shape costs an hour to re-diagnose every time it surfaces. One of
     the session-only tools is the honest signal, since none of them register without one. */
  if (session === 'yes') {
    await waitFor(() => { expect(shell.offered()).toContain('list_trips') })
  }
  const spec = h.specs.find((s) => s.name === 'get_app_state')!
  return String(await spec.execute({}))
}

describe('get_app_state, answering a visitor with no account', () => {
  it('is offered at all — the orientation tool is the likeliest first thing asked for', async () => {
    const shell = shellOn(SAMPLE_PATH, { session: 'no' })
    await settle()
    expect(shell.offered()).toContain('get_app_state')
  })

  it('recommends only the five tools that actually answer on that page', async () => {
    const out = await appStateOn(SAMPLE_PATH, 'no')
    for (const t of ['get_itinerary', 'get_place_evidence', 'show_on_map', 'set_map_mode', 'get_map_view']) {
      expect(out).toContain(`→ ${t}`)
    }
    // The two it used to push hardest, and which are no longer registered here at all.
    expect(out).not.toContain('plan_trip_from_reels')
    expect(out).not.toContain('save_reels')
  })

  it('names an account as the thing standing between them and the rest', async () => {
    /* `blocked` is documented as "anything that would make an obvious next step fail, so the
       agent doesn\'t try it". Without this the agent learns it by trying and failing in front of
       whoever is watching. */
    const out = await appStateOn(SAMPLE_PATH, 'no')
    expect(out).toMatch(/^Blocked: {4}.*need an account/m)
  })

  it('claims nothing about the visitor\'s own reels, places or trips', async () => {
    const out = await appStateOn(SAMPLE_PATH, 'no')
    expect(out).not.toMatch(/saved reels/)
    expect(out).not.toMatch(/unknown number/)
    expect(out).toMatch(/Account: +none/)
  })

  it('does not warn that counts could not be loaded, because none were attempted', async () => {
    const out = await appStateOn(SAMPLE_PATH, 'no')
    expect(out).not.toContain('could not be loaded')
  })

  it('says where they are in terms of a public sample, not "a trip you have already planned"', async () => {
    // The route label is right for a trip the user owns and wrong for this one twice over: the
    // visitor did not plan it, and there is no account for it to belong to.
    const out = await appStateOn(SAMPLE_PATH, 'no')
    expect(out).not.toContain('a trip you have already planned')
    expect(out).toMatch(/You are on: .*sample/)
    /* Anchored on what is unique to the SIGNED-OUT label. The signed-in one also says "sample"
       now, so a looser assertion here would quietly pass against it and stop catching the loss
       of this branch — a test that still runs and no longer proves anything. */
    expect(out).toContain('with no account and nothing spent')
    expect(out).not.toContain('not one of yours')
  })

  it('answers a signed-in user with their real counts and steps', async () => {
    /* The third state must cost the other two nothing. `blocked` is deliberately NOT "nothing"
       here any more — this page carries a real one, that its trip cannot be edited — so this
       asserts the account-scoped half is intact rather than that the whole string is unchanged. */
    const out = await appStateOn(SAMPLE_PATH, 'yes')
    expect(out).toContain('0 saved reels')
    expect(out).toContain('plan_trip_from_reels')
    expect(out).not.toMatch(/Account: +none/)
  })
})

/**
 * What a SIGNED-IN visitor is told they are looking at on `/app/trip/demo`.
 *
 * `ROUTE_LABEL` matches the page with `/^\/app\/trip\//` and calls it "a trip you have already
 * planned". For the sample trail that is false twice over: this visitor did not plan it and
 * nobody did — it is a fixture with no row behind it. On the one page whose whole purpose is
 * demonstrating that this product does not invent things, the orientation tool telling a judge
 * they planned a trip they did not plan is the wrong sentence to ship.
 *
 * The signed-out wording cannot just be reused. This reader HAS an account, all thirteen tools
 * work for them, and their own library is sitting right there — so "say nothing about this
 * person's own reels" would be false in the other direction.
 */
describe('the demo page tells a signed-in visitor what it actually is', () => {
  it('does not claim they planned a trip nobody planned', async () => {
    const out = await appStateOn(SAMPLE_PATH, 'yes')
    expect(out).not.toContain('a trip you have already planned')
    expect(out).toMatch(/You are on: .*example trip, not one of yours/)
  })

  it('says their own library is untouched, because it is', async () => {
    // The correction must not overshoot into implying the demo page limits their account. It
    // does not: all thirteen tools are registered here and every one of them still works.
    const out = await appStateOn(SAMPLE_PATH, 'yes')
    expect(out).toContain('Your own Reels and trips are untouched')
  })

  it('warns in BLOCKED that this trip cannot be edited, before the agent finds out by trying', async () => {
    /* The five edit tools refuse the fixture at the reader, which is correct, but the refusal
       reads as a malfunction to an agent looking straight at the trip: "Which trip?" about a trip
       plainly on screen. `blocked` is documented as "anything that would make an obvious next step
       fail, so the agent doesn't try it" — this sentence exactly. Keeping it out of `where` keeps
       that field about identity and this one about consequences, which is what stops the two
       drifting into each other now that the trip label carries status. */
    const out = await appStateOn(SAMPLE_PATH, 'yes')
    expect(out).toMatch(/^Blocked: {4}.*editing this trip will be refused/m)
    expect(out).not.toMatch(/You are on:.*cannot be edited/)
  })

  it('leaves a real trip page saying exactly what it said before', async () => {
    // Scoped to the fixture. A finished trip the user genuinely owns keeps its original label.
    const out = await tripPageState([tripRow('complete')])
    expect(out).toContain('You are on: a trip you have already planned')
    expect(out).not.toContain('the public sample trail')
  })

  it('matches the sample trail exactly, never as a prefix', async () => {
    /* The same rule middleware:39 applies to the route itself, for the same reason: a prefix
       match would hand the "not one of yours" label to a real trip the user does own. Loaded with
       a real row, so a leak shows up as the sample label REPLACING a correct one. */
    const out = await tripPageState([tripRow('complete', 'demo-2')], '/app/trip/demo-2')
    expect(out).toContain('You are on: a trip you have already planned')
    expect(out).not.toContain('not one of yours')
    expect(out).not.toContain('the public sample trail')
  })
})

/**
 * The trip route, told apart by STATUS.
 *
 * `/^\/app\/trip\//` said "a trip you have already planned" for every trip, and that route
 * renders all six statuses — the page just fetches whatever the id resolves to. On a `generating`
 * trip the claim is premature; on a `failed` one it is simply false. It also has teeth: the label
 * invites the agent to offer an edit, and `_require_trip_editable_state` (backend/main.py:587)
 * admits only `complete` and `saved_with_gaps`, so the agent walks into a refusal the label talked
 * it into.
 *
 * The status is read from what the page already has — the open bundle first because it is live,
 * the listTrips rows second because the bundle is null for the first moments of a trip page, which
 * is exactly when `get_app_state` is called. Neither knowing is an answer, not a licence to guess.
 */
const TRIP_ID = '8f2c1a9e-0000-4000-8000-000000000001'
const OTHER_ID = '8f2c1a9e-0000-4000-8000-000000000002'
const TRIP_PATH = `/app/trip/${TRIP_ID}`

const tripRow = (status: Trip['status'], id = TRIP_ID): Trip =>
  ({ ...TOKYO_TRIP.trip, id, status })

/** Publishes an open bundle the way TripTools does, so the live source can be exercised. */
function PublishOpenTrip({ bundle }: { bundle: TripBundle }) {
  const { openTrip } = useWebMcpRegistry()
  openTrip.current = bundle
  return null
}

const bundleFor = (id: string, status: Trip['status']): TripBundle =>
  ({ ...TOKYO_TRIP, trip: { ...TOKYO_TRIP.trip, id, status } })

/** Mounts on a real trip page with those rows loaded, and returns what get_app_state says. */
async function tripPageState(rows: Trip[], path = TRIP_PATH, open?: TripBundle): Promise<string> {
  h.pathname = path
  h.session = 'yes'
  h.listTrips.mockResolvedValue(rows)
  h.listSavedReelCards.mockResolvedValue([])
  render(
    <WebMcpRegistryProvider>
      <GlobalTools />
      {open && <PublishOpenTrip bundle={open} />}
    </WebMcpRegistryProvider>,
  )
  let out = ''
  await waitFor(async () => {
    const spec = h.specs.find((s) => s.name === 'get_app_state')
    expect(spec).toBeTruthy()
    out = String(await spec!.execute({}))
    expect(out).not.toContain('could not be loaded')
  })
  return out
}

describe('the trip route describes the trip it is actually showing', () => {
  it('does not call a trip that is still building one you have already planned', async () => {
    const out = await tripPageState([tripRow('generating')])
    expect(out).not.toContain('a trip you have already planned')
    expect(out).toMatch(/You are on:.*still being built/)
  })

  it('points the agent at the tool built for that wait', async () => {
    // The whole reason status-aware beats a flat "one of your trips": it can route.
    const out = await tripPageState([tripRow('generating')])
    expect(out).toContain('→ get_trip_progress')
  })

  it('says an unfinished trip cannot be edited, rather than letting the backend say it', async () => {
    // backend/main.py:587 admits complete and saved_with_gaps only.
    const out = await tripPageState([tripRow('generating')])
    expect(out).toMatch(/^Blocked: {4}.*editing this trip will be refused/m)
  })

  it('says outright that a failed trip failed', async () => {
    const out = await tripPageState([tripRow('failed')])
    expect(out).not.toContain('a trip you have already planned')
    expect(out).toMatch(/You are on:.*failed/)
    // Not building, so nothing to follow — the progress tool would answer about nothing.
    expect(out).not.toContain('→ get_trip_progress')
  })

  it('leaves a finished trip saying exactly what it always said', async () => {
    const out = await tripPageState([tripRow('complete')])
    expect(out).toContain('You are on: a trip you have already planned')
    expect(out).toMatch(/^Blocked: {4}nothing$/m)
  })

  it('treats a trip saved with gaps as editable, because the backend does', async () => {
    const out = await tripPageState([tripRow('saved_with_gaps')])
    expect(out).toMatch(/^Blocked: {4}nothing$/m)
  })

  it('prefers the open bundle, because it is live where the loaded rows are a snapshot', async () => {
    /* listTrips is read once per navigation; TripTools republishes the bundle as the trip changes.
       A run that finishes while the user watches must be reported as finished, not as the
       "generating" the list still remembers. */
    const out = await tripPageState(
      [tripRow('generating')], TRIP_PATH, bundleFor(TRIP_ID, 'complete'),
    )
    expect(out).toContain('You are on: a trip you have already planned')
    expect(out).toMatch(/^Blocked: {4}nothing$/m)
  })

  it('ignores a bundle left over from the trip the user was looking at a moment ago', async () => {
    /* The silent-wrong answer: TripTools publishes to one shared ref, so during a navigation
       between two trips the bundle can briefly belong to the previous one. Reporting its status
       as this trip's is the same class of defect get_trip_progress guards against when it checks
       which run it is being asked about. Both sources are keyed on the id in the PATH. */
    const out = await tripPageState(
      [tripRow('generating')], TRIP_PATH, bundleFor(OTHER_ID, 'complete'),
    )
    expect(out).toMatch(/You are on:.*still being built/)
    expect(out).not.toContain('a trip you have already planned')
  })

  it('falls back to the one thing true of all six when the status is unknown', async () => {
    /* An honest flat label beats a status-aware one built on a guess. Nothing here knows this
       trip: it is not among the loaded rows and no bundle has been published. */
    const out = await tripPageState([tripRow('complete', OTHER_ID)])
    expect(out).toContain('You are on: one of your trips')
    expect(out).not.toContain('already planned')
    expect(out).not.toContain('still being built')
    // We do not know it is uneditable either, so we must not claim it is.
    expect(out).toMatch(/^Blocked: {4}nothing$/m)
  })
})

/**
 * One rewrite per trip, and the user can see it happen.
 *
 * Every itinerary edit now starts a summary rewrite by itself (`startSummaryRewrite` in
 * `lib/webmcp/tools/edit.ts`), which moves two obligations onto this component, both of them
 * load-bearing rather than tidy:
 *
 *  - COALESCE. The agent has been told to call `replan_trip` after an edit for this feature's
 *    whole life, and a model does not unlearn that on the day a tool description changes. Without
 *    the in-flight map here, the obedient agent buys a second 30-second narration of the same
 *    trip whose only effect is to overwrite the first one's prose.
 *  - ANNOUNCE. It is an LLM call nobody approved. It costs nothing from the trip allowance
 *    (`/trips/{id}/replan` has only the burst limiter), but work done on the user's behalf that
 *    they cannot see is work they could not consent to — and the running rail entry is also the
 *    "updating the plan" state that keeps a briefly-stale summary from being a silent one.
 *
 * These assertions drive the REAL specs GlobalTools builds, through the real registry, so the
 * wiring is what is under test rather than a re-description of it.
 */
const { replanTrip: replanTripApi } = await import('@/lib/trip/api')
const { getTrip: getTripApi } = await import('@/lib/trip/supabase-api')

/** Whatever the rail is currently holding, captured from the real provider. */
let railEntries: { tool: string; status: string; detail: string | null }[] = []

function WatchRail() {
  const { activity } = useWebMcpRegistry()
  railEntries = activity
  return null
}

/** Answers the approval card yes, for the paths whose point is what happens AFTER consent. */
function AutoApprove() {
  const { pending } = useWebMcpRegistry()
  useEffect(() => {
    if (!pending) return
    cardsShown.push(pending.summary)
    pending.resolve(true)
  }, [pending])
  return null
}

/** A real trip page with a real open bundle, and the tools the agent would find on it. */
async function editableTripPage({ approve = false } = {}): Promise<Record<string, ToolSpec>> {
  h.pathname = TRIP_PATH
  h.listTrips.mockResolvedValue([tripRow('complete')])
  h.listSavedReelCards.mockResolvedValue([])
  render(
    <WebMcpRegistryProvider>
      <GlobalTools />
      <PublishOpenTrip bundle={bundleFor(TRIP_ID, 'complete')} />
      {approve ? <AutoApprove /> : <AutoDecline />}
      <WatchRail />
    </WebMcpRegistryProvider>,
  )
  await waitFor(() => { expect(h.specs.find((s) => s.name === 'move_place')).toBeTruthy() })
  return Object.fromEntries(h.specs.map((s) => [s.name, s]))
}

describe('the summary rewrite an edit starts', () => {
  beforeEach(() => {
    railEntries = []
    vi.mocked(getTripApi).mockResolvedValue(bundleFor(TRIP_ID, 'complete'))
    vi.mocked(editTripPlace).mockResolvedValue(undefined as never)
    vi.mocked(replanTripApi).mockReset()
  })

  /** Hands back a lever per `replanTrip` call, so a rewrite can be held open across an edit. */
  function heldReplans() {
    const calls: { resolve: (r: { days_narrated: number; routes_refreshed: boolean }) => void; reject: (e: unknown) => void }[] = []
    vi.mocked(replanTripApi).mockImplementation(
      () => new Promise((resolve, reject) => { calls.push({ resolve, reject }) }),
    )
    return calls
  }

  const land = (call: { resolve: (r: { days_narrated: number; routes_refreshed: boolean }) => void }) =>
    act(async () => { call.resolve({ days_narrated: 3, routes_refreshed: true }) })

  it('does not let an edit join a rewrite whose prose predates it', async () => {
    /* The defect coalescing introduced, and it is invisible from the browser: `persist_narration`
       (backend/pipeline/persist.py) reads the trip's stops, THEN awaits the narrator for ~30s,
       then writes what it wrote. So a rewrite started by edit A is already committed to prose
       that cannot know about edit B. Joining B into it would land A-only summaries and report
       them as matching the current stops — the exact self-contradiction this whole feature
       exists to remove, restored one layer down and harder to see.
       Sequential edits pass against the bug; the edit has to land WHILE the rewrite is open. */
    const calls = heldReplans()
    const tools = await editableTripPage()

    await act(async () => { await tools.move_place.execute({ place: '1', to_day: 3 }) })
    expect(calls).toHaveLength(1)

    await act(async () => { await tools.move_place.execute({ place: '2', to_day: 3 }) })
    expect(calls, 'a second run must not start while the first is open').toHaveLength(1)

    await land(calls[0])
    await waitFor(() => { expect(calls).toHaveLength(2) })
  })

  it('still costs two narrations for a burst of edits, not one each', async () => {
    // What coalescing was FOR, kept: the queue holds exactly one follow-up however many edits
    // land during a rewrite, so three edits mid-rewrite cost two runs and not four.
    const calls = heldReplans()
    const tools = await editableTripPage()

    await act(async () => { await tools.move_place.execute({ place: '1', to_day: 3 }) })
    await act(async () => { await tools.move_place.execute({ place: '2', to_day: 3 }) })
    await act(async () => { await tools.move_place.execute({ place: '3', to_day: 3 }) })
    expect(calls).toHaveLength(1)

    await land(calls[0])
    await waitFor(() => { expect(calls).toHaveLength(2) })
    await land(calls[1])
    // Nothing is owed any more, so nothing more is bought.
    await act(async () => {})
    expect(calls).toHaveLength(2)
  })

  it('still owes the queued edit a rewrite when the one before it failed', async () => {
    /* A failed narration does not discharge the obligation — the prose is still behind, and the
       follow-up reads the trip fresh either way. Dropping it here would leave the trip
       permanently stale after one unlucky blip. */
    const calls = heldReplans()
    const tools = await editableTripPage()

    await act(async () => { await tools.move_place.execute({ place: '1', to_day: 3 }) })
    await act(async () => { await tools.move_place.execute({ place: '2', to_day: 3 }) })
    await act(async () => { calls[0].reject(new Error('Itinerary narration could not be regenerated')) })

    await waitFor(() => { expect(calls).toHaveLength(2) })
  })

  it('does not wedge itself when a rewrite is still open, and frees up when it lands', async () => {
    /* The record outlives the run it describes, so `replanInFlight` must read the RUN. Asking
       whether the map knows the trip would answer "a rewrite is running" forever after the first
       edit, and `replan_trip` would silently stop asking for approval. */
    const calls = heldReplans()
    const tools = await editableTripPage()

    await act(async () => { await tools.move_place.execute({ place: '1', to_day: 3 }) })
    await land(calls[0])
    await waitFor(() => { expect(calls).toHaveLength(1) })

    // Nothing running now, so the agent's own replan_trip must raise its card again.
    await act(async () => { void tools.replan_trip.execute({}) })
    await waitFor(() => { expect(cardsShown).toHaveLength(1) })
  })

  it('is joined, not duplicated, when the agent calls replan_trip anyway', async () => {
    // The agent has been trained by `next_tool` to do exactly this. It must cost nothing.
    vi.mocked(replanTripApi).mockReturnValue(new Promise(() => {}))
    const tools = await editableTripPage()

    await act(async () => { await tools.move_place.execute({ place: '1', to_day: 3 }) })
    await act(async () => { void tools.replan_trip.execute({}) })

    await waitFor(() => { expect(railEntries.filter((e) => e.tool === 'replan_trip')).toHaveLength(1) })
    expect(replanTripApi).toHaveBeenCalledTimes(1)
    // And no card: the work is already running, so there is nothing left to approve or refuse.
    expect(cardsShown).toHaveLength(0)
  })

  it('shows on the rail while it runs, so a stale summary is never a silent one', async () => {
    vi.mocked(replanTripApi).mockReturnValue(new Promise(() => {}))
    const tools = await editableTripPage()

    await act(async () => { await tools.move_place.execute({ place: '1', to_day: 3 }) })

    await waitFor(() => {
      expect(railEntries.find((e) => e.tool === 'replan_trip')?.status).toBe('running')
    })
  })

  it('records what it rewrote once it lands', async () => {
    vi.mocked(replanTripApi).mockResolvedValue({ days_narrated: 3, routes_refreshed: true })
    const tools = await editableTripPage()

    await act(async () => { await tools.move_place.execute({ place: '1', to_day: 3 }) })

    await waitFor(() => {
      const entry = railEntries.find((e) => e.tool === 'replan_trip')
      expect(entry?.status).toBe('done')
      expect(entry?.detail).toContain('Rewrote 3 day summaries')
    })
  })

  it('says the edit survived when the rewrite did not', async () => {
    /* Guardrail #3. The move is already persisted; a rail entry reading only "REWRITE FAILED"
       invites the user to believe their edit was rolled back with it. */
    vi.mocked(replanTripApi).mockRejectedValue(new Error('Itinerary narration could not be regenerated'))
    const tools = await editableTripPage()

    let out: { outcome?: string } = {}
    await act(async () => {
      out = JSON.parse(String(await tools.move_place.execute({ place: '1', to_day: 3 })))
    })
    expect(out.outcome).toBe('done')

    await waitFor(() => {
      const entry = railEntries.find((e) => e.tool === 'replan_trip')
      expect(entry?.status).toBe('failed')
      expect(entry?.detail).toContain('The edit was saved')
    })
  })

  it('does not invent an edit in the record when a manual rewrite fails', async () => {
    /* `replan_trip` can be approved and run with no edit behind it at all, and on failure the
       rail said "The edit was saved" regardless — a durable record asserting something that never
       happened, while the tool's own reply said only that replanning failed. Two records of one
       call, contradicting each other. Same class as the REMOVED entry written for a removal the
       user had refused. */
    vi.mocked(replanTripApi).mockRejectedValue(new Error('Itinerary narration could not be regenerated'))
    const tools = await editableTripPage({ approve: true })

    /* NOT wrapped in act(): the tool awaits its own approval card, and AutoApprove answers it
       from an effect — awaiting the call inside act() deadlocks the two against each other. */
    const call = tools.replan_trip.execute({})
    await waitFor(() => { expect(cardsShown).toHaveLength(1) })
    await call

    await waitFor(() => {
      const entry = railEntries.find((e) => e.tool === 'replan_trip')
      expect(entry?.status).toBe('failed')
      expect(entry?.detail).not.toContain('The edit was saved')
      expect(entry?.detail).toContain('could not be rewritten')
    })
  })

  it('lets the next edit start a fresh rewrite once the last one has settled', async () => {
    // Coalescing must not become a permanent lock: a trip whose rewrite has finished is a trip
    // whose next edit needs its own.
    vi.mocked(replanTripApi).mockResolvedValue({ days_narrated: 3, routes_refreshed: true })
    const tools = await editableTripPage()

    await act(async () => { await tools.move_place.execute({ place: '1', to_day: 3 }) })
    await waitFor(() => { expect(replanTripApi).toHaveBeenCalledTimes(1) })
    await act(async () => { await tools.move_place.execute({ place: '2', to_day: 3 }) })
    await waitFor(() => { expect(replanTripApi).toHaveBeenCalledTimes(2) })
  })
})
