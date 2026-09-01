import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import type { ToolSpec } from '@/lib/webmcp/types'
import { resetViewIntent, takeViewIntent } from '@/lib/webmcp/view-intent'

/**
 * The page follows the agent.
 *
 * Reported from real use in ChatGPT's in-app browser: `save_reels` wrote to the database and
 * returned, `plan_trip_from_reels` opened a stream only /app renders — and from anywhere else the
 * agent narrated a success while the screen sat still. That is the whole thesis of this
 * integration failing quietly: an agent action is supposed to be indistinguishable from a user
 * action, and a user who saves a reel lands in their library.
 *
 * These assertions are about CAUSE as much as effect. Every navigation here is the direct result
 * of a tool call made this turn; nothing in this component may move the page on its own, because
 * yanking someone off a page they are reading is worse than not moving at all.
 */

const h = vi.hoisted(() => ({
  pathname: '/app',
  specs: [] as ToolSpec[],
  push: vi.fn(),
  /** The single-run lock. `null` = already taken, which is what the shell answers by default. */
  reserve: vi.fn<() => { begin: (id: string) => void; release: () => void } | null>(() => null),
  listTrips: vi.fn(),
  listSavedReelCards: vi.fn(),
  captureSavedReel: vi.fn(),
  startOrganize: vi.fn(),
  generateTrip: vi.fn(),
  readEntitlement: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  usePathname: () => h.pathname,
  useRouter: () => ({ push: h.push }),
}))

vi.mock('@/lib/trip/supabase-api', () => ({ listTrips: () => h.listTrips(), getTrip: vi.fn(), getMemoryPreferences: async () => ({ status: 'ok', facts: [
    { id: 'm1', memory: 'Prefers walkable days', created_at: '2026-08-01T00:00:00Z', source: 'mem0' },
  ] }) }))

vi.mock('@/lib/reels/api', () => ({
  listSavedReelCards: () => h.listSavedReelCards(),
  captureSavedReel: (url: string, token: string) => h.captureSavedReel(url, token),
  startOrganize: (ids: string[], token: string) => h.startOrganize(ids, token),
}))

vi.mock('@/lib/supabase/session', () => ({ getAccessToken: () => Promise.resolve('test-token') }))

// Spread the real module: ApiError is a class the generation tool branches on with `instanceof`.
vi.mock('@/lib/trip/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/trip/api')>(),
  generateTrip: (...args: unknown[]) => h.generateTrip(...args),
  addTripPlace: vi.fn(), deleteTripPlace: vi.fn(), editTripDates: vi.fn(),
  editTripPlace: vi.fn(), replanTrip: vi.fn(),
}))

vi.mock('@/lib/entitlement', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/entitlement')>(),
  readEntitlement: () => h.readEntitlement(),
}))

// Only the two fields GlobalTools reads off the shell. The run itself is GenerationProvider's
// business and has its own tests; what matters here is that a committed run moves the page.
vi.mock('@/components/generation/GenerationProvider', async () => {
  const { createGenerationStore } = await import('@/lib/webmcp/generation')
  const store = createGenerationStore()
  return { useGeneration: () => ({ store, reserve: () => h.reserve() }) }
})

vi.mock('../RegisterTools', () => ({
  RegisterTools: ({ specs }: { specs: ToolSpec[] }) => { h.specs = specs; return null },
}))

const { WebMcpRegistryProvider, useWebMcpRegistry } = await import('../WebMcpRegistry')
const { default: GlobalTools } = await import('../GlobalTools')
const { useEffect } = await import('react')

/** Approves every card the tools raise, so an approval-gated tool can be driven end to end. */
function AutoApprove() {
  const { pending } = useWebMcpRegistry()
  /* Either card. `plan_trip_from_reels` raises the one with a preference field when Astrail has
     something remembered to lean on, and a harness that answers only the plain shape would hang
     that path instead of testing it. `text: null` is the blank field — today's behaviour. */
  useEffect(() => {
    if (!pending) return
    if (pending.kind === 'prompt') pending.resolve({ approved: true, text: null })
    else pending.resolve(true)
  }, [pending])
  return null
}

/** The other answer. A declined spend must leave the app exactly where it was. */
function AutoDecline() {
  const { pending } = useWebMcpRegistry()
  useEffect(() => {
    if (!pending) return
    if (pending.kind === 'prompt') pending.resolve({ approved: false, text: null })
    else pending.resolve(false)
  }, [pending])
  return null
}

/** Stands in for a mounted SavedReelsFlow publishing its re-fetch into the registry slot. */
function PageRefresh({ refresh }: { refresh: () => Promise<void> }) {
  const { refreshSavedReels } = useWebMcpRegistry()
  useEffect(() => {
    refreshSavedReels.current = refresh
    return () => { refreshSavedReels.current = null }
  }, [refreshSavedReels, refresh])
  return null
}

const REEL = 'https://www.instagram.com/reel/Cabc123/'
const PLAN_ARGS = { reel_urls: [REEL], start_date: '2026-03-03', end_date: '2026-03-07' }

/** Mounts the shell on `path` and hands back one tool, exactly as the agent would call it. */
async function toolOn(path: string, name: string): Promise<ToolSpec> {
  h.pathname = path
  render(<WebMcpRegistryProvider><GlobalTools /><AutoApprove /></WebMcpRegistryProvider>)
  let spec: ToolSpec | undefined
  await waitFor(() => {
    spec = h.specs.find((s) => s.name === name)
    expect(spec, `${name} was never built`).toBeTruthy()
  })
  return spec!
}

/**
 * Stand in for the page arriving, and prove it was asked for.
 *
 * `takeViewIntent` is what SavedReelsFlow calls on mount; calling it here is the acknowledgement
 * that releases the waiting tool. Retried, because the intent is raised inside an async execute.
 */
async function pageArrives(): Promise<void> {
  await waitFor(() => { expect(takeViewIntent()).not.toBeNull() })
}

beforeEach(() => {
  h.specs = []
  h.pathname = '/app'
  h.push.mockReset()
  h.reserve.mockReset().mockReturnValue(null)
  h.listTrips.mockReset().mockResolvedValue([])
  h.listSavedReelCards.mockReset().mockResolvedValue([])
  h.captureSavedReel.mockReset().mockResolvedValue({ saved_reel: { id: 'sr_1', analysis_status: 'not_analyzed' } })
  h.startOrganize.mockReset().mockResolvedValue({ job_id: 'job_1' })
  h.generateTrip.mockReset().mockResolvedValue({ trip_id: 'trip-123' })
  h.readEntitlement.mockReset().mockResolvedValue({ plan: 'beta', lifetimeTripCount: 0, seatRequestedAt: null })
})

afterEach(() => { resetViewIntent() })

describe('save_reels takes the user to their library', () => {
  it('moves the app there from another route', async () => {
    const spec = await toolOn('/app/settings', 'save_reels')
    const run = spec.execute({ urls: [REEL] })
    await waitFor(() => { expect(h.push).toHaveBeenCalledWith('/app') })
    await pageArrives()
    expect(String(await run)).toContain('Saved 1 of 1')
  })

  it('does not resolve until the page is there', async () => {
    // The rule the edit tools already follow: a mutation resolves only once the UI reflects it.
    // Reporting first and navigating afterwards is how the agent describes a library the user is
    // not looking at yet.
    const spec = await toolOn('/app/settings', 'save_reels')
    const run = Promise.resolve(spec.execute({ urls: [REEL] }))
    let done = false
    void run.then(() => { done = true })
    await waitFor(() => { expect(h.push).toHaveBeenCalledWith('/app') })
    expect(done).toBe(false)
    await pageArrives()
    await run
    expect(done).toBe(true)
  })

  it('pushes nothing when the library is already the route, and still waits for it', async () => {
    /* A push to the route you are on is a wasted navigation the router has to reconcile, and on
       a page mid-workflow it is a re-render nobody asked for. The intent is still raised: the
       page on screen is the thing that acknowledges it. */
    const spec = await toolOn('/app', 'save_reels')
    const run = spec.execute({ urls: [REEL] })
    await pageArrives()
    expect(String(await run)).toContain('Saved 1 of 1')
    expect(h.push).not.toHaveBeenCalled()
  })

  it('moves nothing when nothing was saved', async () => {
    // Navigation is only ever the direct result of something that happened. A rejected link
    // changed nothing in the library, so there is nothing to go and look at.
    const spec = await toolOn('/app/settings', 'save_reels')
    expect(String(await spec.execute({ urls: ['https://evil.example.com/steal'] })))
      .toContain('Saved 0 of 1')
    expect(h.push).not.toHaveBeenCalled()
    expect(takeViewIntent()).toBeNull()
  })

  it('lets the page catch up with the save BEFORE putting it on screen', async () => {
    /* The reveal opens the Library, which renders the PAGE's cards — so revealing before that
       list has caught up shows "No saved reels yet" for as long as the fetch takes. The account
       most likely to see it is the one saving for the very first time, i.e. every new user's
       first minute with the product.

       Ordering, not merely presence: the refresh has to be finished before the intent exists at
       all. Once for the batch rather than once per reel — the fire-and-forget refreshes inside
       each save keep the list live WHILE the batch runs, but any one of them can resolve before
       a later reel lands, so none of them can be the guarantee. */
    let listed!: () => void
    const listing = new Promise<void>((resolve) => { listed = resolve })
    const refresh = vi.fn(() => listing)
    h.pathname = '/app'
    render(
      <WebMcpRegistryProvider><GlobalTools /><AutoApprove /><PageRefresh refresh={refresh} /></WebMcpRegistryProvider>,
    )
    let spec: ToolSpec | undefined
    await waitFor(() => {
      spec = h.specs.find((s) => s.name === 'save_reels')
      expect(spec).toBeTruthy()
    })

    const run = Promise.resolve(spec!.execute({ urls: [REEL] }))
    await waitFor(() => { expect(refresh).toHaveBeenCalled() })
    expect(takeViewIntent()).toBeNull() // the screen has not been asked to move yet

    listed()

    await pageArrives()
    expect(String(await run)).toContain('Saved 1 of 1')
  })

  it('still shows the library when the page cannot refresh itself', async () => {
    // A list that fails to reload is a stale library; not revealing at all is the bug this whole
    // channel exists to fix. Stale beats absent, and the save is reported either way.
    const refresh = vi.fn().mockRejectedValue(new Error('offline'))
    h.pathname = '/app'
    render(
      <WebMcpRegistryProvider><GlobalTools /><AutoApprove /><PageRefresh refresh={refresh} /></WebMcpRegistryProvider>,
    )
    let spec: ToolSpec | undefined
    await waitFor(() => {
      spec = h.specs.find((s) => s.name === 'save_reels')
      expect(spec).toBeTruthy()
    })

    const run = spec!.execute({ urls: [REEL] })

    await pageArrives()
    expect(String(await run)).toContain('Saved 1 of 1')
  })
})

describe('plan_trip_from_reels takes the user to the wait screen', () => {
  it('moves the app to the page that renders the run, from another route', async () => {
    /* GenerationScene renders only inside SavedReelsFlow, i.e. only on /app. Started from
       /app/trips the user used to see nothing for 60-180 seconds and then be teleported to a
       finished trip — the agent's longest, most visible action, invisible. */
    const begin = vi.fn()
    h.reserve.mockReturnValue({ begin, release: vi.fn() })
    const spec = await toolOn('/app/trips', 'plan_trip_from_reels')
    const run = spec.execute(PLAN_ARGS)
    await waitFor(() => { expect(h.push).toHaveBeenCalledWith('/app') })
    // ORDER: the run is attached to the shell BEFORE the page moves, so the page it lands on
    // already has a run to render rather than briefly showing the empty library.
    expect(begin).toHaveBeenCalledWith('trip-123')
    await pageArrives()
    expect(JSON.parse(String(await run))).toMatchObject({ trip_id: 'trip-123', status: 'generating' })
  })

  it('moves nothing when the run is refused the single-run lock', async () => {
    // No reservation means no run was created, so /app would show the plain library while the
    // agent claims a trip is building. A refusal is not a result worth navigating to.
    h.reserve.mockReturnValue(null)
    const spec = await toolOn('/app/settings', 'plan_trip_from_reels')
    await expect(spec.execute(PLAN_ARGS)).rejects.toThrow(/already being built/)
    expect(h.push).not.toHaveBeenCalled()
    expect(takeViewIntent()).toBeNull()
  })

  it('moves nothing when the user declines the spend', async () => {
    // The clearest case of navigation that would be pure noise: the user said no, so there is
    // nothing new to look at anywhere.
    h.reserve.mockReturnValue({ begin: vi.fn(), release: vi.fn() })
    h.pathname = '/app/settings'
    render(<WebMcpRegistryProvider><GlobalTools /><AutoDecline /></WebMcpRegistryProvider>)
    let spec: ToolSpec | undefined
    await waitFor(() => {
      spec = h.specs.find((s) => s.name === 'plan_trip_from_reels')
      expect(spec).toBeTruthy()
    })
    expect(String(await spec!.execute(PLAN_ARGS))).toMatch(/declined/i)
    expect(h.push).not.toHaveBeenCalled()
    expect(takeViewIntent()).toBeNull()
  })
})

describe('nothing but a tool call moves the page', () => {
  it('never navigates on mount, a route change, or a data load', async () => {
    /* The hostile case. Every reader in this component re-runs on navigation — the session read,
       the trips load, the reel counts — and any of them wired to a navigation would drag a user
       off a page they were reading, on a timer they cannot see. */
    h.listTrips.mockResolvedValue([{ id: 't1', status: 'complete' } as never])
    h.listSavedReelCards.mockResolvedValue([{ places: [{ name: 'Senso-ji' }] } as never])
    const view = render(<WebMcpRegistryProvider><GlobalTools /></WebMcpRegistryProvider>)
    await waitFor(() => { expect(h.specs.length).toBeGreaterThan(0) })
    h.pathname = '/app/settings'
    view.rerender(<WebMcpRegistryProvider><GlobalTools /></WebMcpRegistryProvider>)
    await waitFor(() => { expect(h.listTrips).toHaveBeenCalledTimes(2) })
    expect(h.push).not.toHaveBeenCalled()
    expect(takeViewIntent()).toBeNull()
  })
})
