import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import type { Trip } from '@/lib/trip/backend-types'
import type { Entitlement } from '@/lib/entitlement'

/**
 * What a judge with no account is actually handed on `/app/trip/demo`.
 *
 * Every other test in this directory stubs `RegisterTools` to inspect the specs. This one does
 * not, because the question here is not what GlobalTools computed — it is what reached the
 * browser, and whether the number on the page agrees with it. Those are two different surfaces
 * (`document.modelContext` and the WebMCP chip) fed by two different code paths, and a judge sees
 * both at once; README tells them to check that they match.
 *
 * So this mounts the real registration, the real registry and the real chip, with both halves of
 * the page's tool surface: GlobalTools from the /app layout and TripTools from the trip page.
 */

const h = vi.hoisted(() => ({
  pathname: '/app/trip/demo',
  signedIn: false,
  listTrips: vi.fn<() => Promise<Trip[]>>(),
  listSavedReelCards: vi.fn<() => Promise<{ places: { name: string }[] }[]>>(),
}))

// GlobalTools navigates from inside a tool call (the page follows the agent), so the router
// has to exist here even though nothing in this file drives one.
vi.mock('next/navigation', () => ({ usePathname: () => h.pathname, useRouter: () => ({ push: vi.fn() }) }))

vi.mock('@/lib/trip/supabase-api', () => ({
  listTrips: () => h.listTrips(),
  getTrip: vi.fn(),
  getMemoryPreferences: async () => ({ status: 'ok', facts: [
    { id: 'm1', memory: 'Prefers walkable days', created_at: '2026-08-01T00:00:00Z', source: 'mem0' },
  ] }),
}))

vi.mock('@/lib/reels/api', () => ({
  listSavedReelCards: () => h.listSavedReelCards(),
  captureSavedReel: vi.fn(),
  startOrganize: vi.fn(),
}))

// The one seam the gate reads, and the same call every withheld tool makes.
vi.mock('@/lib/supabase/session', () => ({
  getAccessToken: () =>
    h.signedIn ? Promise.resolve('test-token') : Promise.reject(new Error('Not signed in')),
}))

// Spread the real module: `ApiError` is a class the generation tool branches on with `instanceof`.
vi.mock('@/lib/trip/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/trip/api')>(),
  addTripPlace: vi.fn(), deleteTripPlace: vi.fn(), editTripDates: vi.fn(),
  editTripPlace: vi.fn(), generateTrip: vi.fn(), replanTrip: vi.fn(),
}))

vi.mock('@/lib/entitlement', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/entitlement')>(),
  readEntitlement: (): Promise<Entitlement> =>
    Promise.resolve({ plan: 'trial', lifetimeTripCount: 0, seatRequestedAt: null }),
}))

vi.mock('@/components/generation/GenerationProvider', async () => {
  const { createGenerationStore } = await import('@/lib/webmcp/generation')
  const store = createGenerationStore()
  return { useGeneration: () => ({ store, reserve: () => null }) }
})

// Only `getMap` is reached, and only by get_map_view. Mocking it keeps Mapbox out of this file.
vi.mock('@/components/map/MapProvider', () => ({
  useSharedMap: () => ({ getMap: () => null }),
}))

const { WebMcpRegistryProvider } = await import('../WebMcpRegistry')
const { default: GlobalTools } = await import('../GlobalTools')
const { default: TripTools } = await import('../TripTools')
const { default: WebMcpStatusBase } = await import('../WebMcpStatus')

/** The dock owns the open state in the app; this mirrors that for the component under test. */
function WebMcpStatus() {
  const [open, setOpen] = useState(false)
  return <WebMcpStatusBase open={open} onOpenChange={setOpen} />
}

/** Every tool this browser was actually offered, in registration order. */
type OfferedTool = { name: string; execute: (args: Record<string, unknown>) => Promise<unknown> }
const registered: OfferedTool[] = []
const names = () => registered.map((t) => t.name)

/** Calls a tool the way the browser would, and unwraps the MCP envelope it answers in. */
async function callTool(name: string): Promise<string> {
  const tool = registered.find((t) => t.name === name)
  if (!tool) throw new Error(`${name} was never offered — [${names().join(', ')}]`)
  const res = (await tool.execute({})) as { content: { text: string }[] }
  return res.content.map((c) => c.text).join('\n')
}

beforeEach(() => {
  registered.length = 0
  h.pathname = '/app/trip/demo'
  h.signedIn = false
  // A signed-out visitor gets exactly this from both reads.
  h.listTrips.mockRejectedValue(new Error('Not signed in'))
  h.listSavedReelCards.mockRejectedValue(new Error('Not signed in'))
  // The native API, stubbed. Returning undefined rather than a promise keeps unregistration
  // (which is an abort) from producing a rejection nobody holds — the defect use-register-tool
  // exists to work around, and not what this file is testing.
  Object.defineProperty(document, 'modelContext', {
    configurable: true,
    value: {
      registerTool: (tool: OfferedTool) => { registered.push(tool) },
    },
  })
})

afterEach(() => {
  Reflect.deleteProperty(document, 'modelContext')
})

/** The public sample trail, mounted the way the /app layout and the trip page mount it. */
function mountSampleTrail() {
  return render(
    <WebMcpRegistryProvider>
      <GlobalTools />
      <TripTools
        bundle={TOKYO_TRIP}
        readOnly
        showDay={vi.fn()}
        selectPlace={vi.fn()}
        setLayerMode={vi.fn()}
        openPanel={vi.fn()}
        refresh={vi.fn(async () => TOKYO_TRIP)}
      />
      <WebMcpStatus />
    </WebMcpRegistryProvider>,
  )
}

/** The six that answer with no account: orientation, two fixture reads, three live-map tools. */
const ANSWERS_SIGNED_OUT = [
  'get_app_state', 'get_itinerary', 'get_place_evidence',
  'get_map_view', 'set_map_mode', 'show_on_map',
]

describe('the public sample trail, as a judge with no account sees it', () => {
  it('offers the browser only the six tools that answer there', async () => {
    /* The captured defect: every tool was registered from the /app layout with no session
       gate of any kind, and eleven of them fail without a JWT. The agent was reading a menu of
       failures it had been invited to order from. */
    mountSampleTrail()
    await waitFor(() => { expect(names()).toHaveLength(6) })
    expect([...names()].sort()).toEqual([...ANSWERS_SIGNED_OUT].sort())
  })

  it('never offers a tool that needs a session, at any point during the load', async () => {
    /* Not just at the end. The gate fails toward the SMALL list while the session read is in
       flight precisely so this holds for the whole load — a list that started at the full set and
       shrank would advertise failures during the window a freshly loaded agent reads it. */
    mountSampleTrail()
    await waitFor(() => { expect(names()).toHaveLength(6) })
    for (const name of ['list_trips', 'list_saved_reels', 'save_reels', 'plan_trip_from_reels',
      'get_trip_progress', 'add_place', 'move_place', 'remove_place', 'replan_trip',
      'set_trip_dates']) {
      expect(names()).not.toContain(name)
    }
  })

  it('shows the same count on the page as it gave the browser', async () => {
    // Two surfaces, two code paths, one judge looking at both. README tells them to compare.
    mountSampleTrail()
    await waitFor(() => { expect(names()).toHaveLength(6) })
    await screen.findByLabelText(`WebMCP active, ${registered.length} tools`)
    expect(screen.getByText('WebMCP active · 6 tools')).toBeInTheDocument()
  })

  it('lists those six by name when the chip is opened', async () => {
    mountSampleTrail()
    const chip = await screen.findByLabelText('WebMCP active, 6 tools')
    await userEvent.click(chip)
    for (const name of ANSWERS_SIGNED_OUT) {
      expect(await screen.findByText(name)).toBeInTheDocument()
    }
    expect(screen.queryByText('list_trips')).not.toBeInTheDocument()
  })

  it('recommends nothing it did not also offer', async () => {
    /* The one assertion neither component can make alone: `get_app_state` is built in GlobalTools
       and names three tools that TripTools registers, so only a mount of both can prove the
       recommendation and the offer agree. If they ever drift, the agent is told to call something
       the browser was never given — the exact failure this whole change exists to remove, just
       arriving one turn later and through the tool the integration was justified by. */
    mountSampleTrail()
    await waitFor(() => { expect(names()).toHaveLength(6) })
    const recommended = [...(await callTool('get_app_state')).matchAll(/→ (\w+)/g)].map((m) => m[1])
    expect(recommended).toHaveLength(5)
    for (const tool of recommended) expect(names()).toContain(tool)
  })

  it('gives a signed-in visitor to the same page all seventeen', async () => {
    // The gate is about the missing credential, not about the route. A JWT makes the other
    // eleven work here exactly as they do anywhere else in /app.
    h.signedIn = true
    h.listTrips.mockResolvedValue([])
    h.listSavedReelCards.mockResolvedValue([])
    mountSampleTrail()
    await waitFor(() => { expect(names()).toHaveLength(17) })
    expect(await screen.findByLabelText('WebMCP active, 17 tools')).toBeInTheDocument()
  })
})
