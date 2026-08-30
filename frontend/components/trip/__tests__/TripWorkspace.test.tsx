import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useRef } from 'react'
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import { thumbnailFor } from '@/components/map/popup-model'
import { placesForDay } from '@/lib/trip/selectors'
import { resolvePlaceRef } from '@/lib/webmcp/resolve'
import type { StreamEvent, TripBundle } from '@/lib/trip/backend-types'

const { getTrip, MapCtor, mapInstance, mapProps } = vi.hoisted(() => {
  const handler = () => ({ enable: vi.fn(), disable: vi.fn() })
  const mapInstance = {
    on: vi.fn(), setConfigProperty: vi.fn(),
    remove: vi.fn(), resize: vi.fn(), stop: vi.fn(),
    style: { setTransition: vi.fn() },
    scrollZoom: handler(), boxZoom: handler(), dragRotate: handler(), dragPan: handler(),
    keyboard: handler(), doubleClickZoom: handler(), touchZoomRotate: handler(), touchPitch: handler(),
  }
  // Captures TripMap's props so a test can drive a real pin tap through onSelectPlace.
  return {
    getTrip: vi.fn(), MapCtor: vi.fn(() => mapInstance), mapInstance,
    mapProps: { current: null as null | { onSelectPlace: (id: string) => void } },
  }
})

vi.mock('@/lib/trip/supabase-api', () => ({ getTrip }))
vi.mock('@/components/map/TripMap', () => ({
  default: (props: { onSelectPlace: (id: string) => void }) => {
    mapProps.current = props
    return <div data-testid="trip-map" />
  },
}))
vi.mock('mapbox-gl', () => ({
  default: { Map: MapCtor, Marker: vi.fn(), LngLatBounds: vi.fn(), accessToken: '' },
}))
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}))
// GenerationProvider owns the router push on a finished run; this suite only cares that the run
// reaches `complete`, not where it navigates.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
// Lightweight stamp: renders the tripId it receives, so the mount tests observe both presence
// (per the status matrix) and WHICH id flows (the loaded bundle's, never the route param). This
// keeps the suite's existing @/lib/trip/* mocks valid — the real panel's api/session deps stay out.
vi.mock('@/components/trip/TripFeedbackPanel', () => ({
  default: ({ tripId }: { tripId: string }) => <div data-testid="trip-feedback-panel">{tripId}</div>,
}))

import MapProvider from '@/components/map/MapProvider'
import GenerationProvider, { useGeneration } from '@/components/generation/GenerationProvider'
import {
  WebMcpRegistryProvider, useWebMcpRegistry,
} from '@/components/webmcp/WebMcpRegistry'
import TripWorkspace from '@/components/trip/TripWorkspace'

function fireLoad() {
  const load = mapInstance.on.mock.calls.find((c) => c[0] === 'load')
  act(() => { (load?.[1] as () => void)?.() })
}

// The shell map is built lazily, so acquisition settles a microtask after mount.
async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

function renderWorkspace(tripId: string) {
  return render(
    <MapProvider>
      <TripWorkspace tripId={tripId} />
    </MapProvider>,
  )
}

/* The real registry, not a mock of it: the marker's whole job is to reflect the SAME activity
   entry the rail reflects, so a stubbed flag would prove the marker renders and prove nothing
   about it being connected to a rewrite. */
function renderWorkspaceWithRegistry(tripId: string) {
  const reg = { current: null as null | ReturnType<typeof useWebMcpRegistry> }
  function Probe() { reg.current = useWebMcpRegistry(); return null }
  const view = render(
    <WebMcpRegistryProvider>
      <Probe />
      <MapProvider>
        <TripWorkspace tripId={tripId} />
      </MapProvider>
    </WebMcpRegistryProvider>,
  )
  return { ...view, reg }
}

describe('TripWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN = 'pk.test'
  })
  afterEach(() => { delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN })

  it('loads the trip and renders day-1 places', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    renderWorkspace(TOKYO_TRIP.trip.id)
    const firstDay1Place = placesForDay(TOKYO_TRIP, 1)[0].place.name
    expect(await screen.findByText(firstDay1Place)).toBeInTheDocument()
    expect(await screen.findByTestId('trip-map')).toBeInTheDocument()
  })

  /* The cover tile is the one thing on the timeline that needs data the LIST does not hold: the
     Reel thumbnail hangs off the bundle, so `ItineraryCards` can only draw it if the workspace
     hands the bundle down. It shipped without that prop and every stop fell back to the dashed
     placeholder — a whole-panel regression that ItineraryCards' own tests could not see, because
     they pass a bundle in directly. The seam is what needs asserting, so this test renders the
     real workspace and demands a real thumbnail. */
  it('hands the bundle down so Reel covers can render', async () => {
    const withCover = placesForDay(TOKYO_TRIP, 1).find((tp) => thumbnailFor(TOKYO_TRIP, tp))
    expect(withCover, 'day-1 fixture must have at least one Reel-derived cover').toBeTruthy()

    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    renderWorkspace(TOKYO_TRIP.trip.id)

    const card = (await screen.findByText(withCover!.place.name)).closest('[data-place-id]')
    expect(card?.querySelector('img')).toHaveAttribute('src', thumbnailFor(TOKYO_TRIP, withCover!))
  })

  it('activates a pin\'s own day when it is selected from the map', async () => {
    // The map shows every day's pins; the itinerary list shows only the active day. Selecting a
    // Day 3 pin while Day 1 was open opened the panel on a list that did not contain it — no
    // card to highlight, and ItineraryCards' scroll-into-view silently found nothing.
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    renderWorkspace(TOKYO_TRIP.trip.id)

    // Assert on the itinerary CARD, not the place name: the fixture's routing warning also says
    // "Tokyo Disneyland", so a text query matches before the day ever switches.
    const card = (id: string) => document.querySelector(`[data-place-id="${id}"]`)
    const day1 = placesForDay(TOKYO_TRIP, 1)[0]
    const day3 = placesForDay(TOKYO_TRIP, 3)[0]

    await waitFor(() => expect(card(day1.place_id)).not.toBeNull())
    expect(card(day3.place_id)).toBeNull()          // day 3's card is absent while day 1 is open

    await act(async () => { mapProps.current!.onSelectPlace(day3.place_id) })

    expect(card(day3.place_id)).not.toBeNull()
    expect(card(day3.place_id)).toHaveAttribute('aria-current', 'true')
    expect(card(day1.place_id)).toBeNull()          // the day switched, not merely appended
  })

  /* The panel, the map and the WebMCP tools must say ONE number per stop. The panel used to
     count 01, 02 within the open day while the map and `resolvePlaceRef` count 1..N across the
     whole trip — so on any day after the first, a user reading "01" and saying "move stop 1"
     moved a stop they were not looking at, and the agent confirmed it did what was asked.
     Asserted through the real workspace, because the wiring is where the two schemes came
     apart, and asserted by feeding the PAINTED number back through the agent's own resolver,
     so this cannot pass on two copies of one hard-coded constant. */
  it('labels a stop with the number the map and the tools answer to, not a per-day count', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    renderWorkspace(TOKYO_TRIP.trip.id)
    const day2 = placesForDay(TOKYO_TRIP, 2)[0]

    await waitFor(() => expect(document.querySelector('[data-place-id]')).not.toBeNull())
    await act(async () => { mapProps.current!.onSelectPlace(day2.place_id) })

    const card = document.querySelector<HTMLElement>(`[data-place-id="${day2.place_id}"]`)!
    const painted = within(card).getByText(/^\d+$/).textContent!
    const resolved = resolvePlaceRef(TOKYO_TRIP, painted)
    expect(resolved.ok && resolved.tripPlace.id).toBe(day2.id)
    expect(Number(painted)).not.toBe(1)   // day 2 continues the trail; it does not restart it
  })

  /* With the separate "Getting around" section gone, the folded links are the ONLY place the
     day's routing appears — so dropping the `legs` prop would delete distances, durations and
     the no-route warnings from the product while every ItineraryCards test stayed green. The
     wiring is pinned here for that reason, and on the arriving stop so it cannot pass by
     printing the leg just anywhere on the page. */
  it('folds the day transport legs into the itinerary, now their only home', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    renderWorkspace(TOKYO_TRIP.trip.id)

    await waitFor(() => expect(document.querySelector('[data-place-id]')).not.toBeNull())
    // leg_1 runs Akasaka Station -> Harry Potter Cafe on day 1: 150 s over 130 m.
    const arrival = placesForDay(TOKYO_TRIP, 1)[1]
    const step = document.querySelector(`[data-place-id="${arrival.place_id}"]`)!.closest('li')!
    expect(step).toHaveTextContent('3 min')
    expect(step).toHaveTextContent('0.1 km')
  })

  it('leaks no source comment into the rendered page', async () => {
    /* Inside JSX a `//` line is NOT a comment — it is a text child, and React renders it. Four
       such lines sat above <main> and took 48px of page flow, pushing a 100dvh element that far
       down: a strip of map above the details panel, and 48px of the panel below the fold. It was
       invisible as text only because it is dark-on-dark, which is exactly why nothing caught it.
       Braced comments are stripped, so this asserts the OUTPUT rather than the source style. */
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    renderWorkspace(TOKYO_TRIP.trip.id)
    await screen.findByTestId('trip-map')

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const leaked: string[] = []
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = (n.nodeValue ?? '').trim()
      if (text.startsWith('//') || text.startsWith('/*')) leaked.push(text.slice(0, 60))
    }
    expect(leaked).toEqual([])
  })

  it('toggles the panel open/closed from the single edge control', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    renderWorkspace(TOKYO_TRIP.trip.id)

    const toggle = await screen.findByRole('button', { name: /hide trip details/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById('trip-details-scroll')).not.toHaveAttribute('inert')

    // Collapse: same control flips to a reopen affordance and the content goes inert.
    fireEvent.click(toggle)
    const reopen = screen.getByRole('button', { name: /show trip details/i })
    expect(reopen).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById('trip-details-scroll')).toHaveAttribute('inert')

    // Reopen from the very same control — closing is never a dead end.
    fireEvent.click(reopen)
    expect(screen.getByRole('button', { name: /hide trip details/i })).toHaveAttribute('aria-expanded', 'true')
    expect(document.getElementById('trip-details-scroll')).not.toHaveAttribute('inert')
  })

  // This route sits outside the (shell) layout (no sidebar), so the panel must carry its own
  // up-nav back to the trips list — otherwise an opened trip is a dead end with no way home.
  it('offers an up-nav link back to the trips list', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    renderWorkspace(TOKYO_TRIP.trip.id)
    const back = await screen.findByRole('link', { name: /all trails/i })
    expect(back).toHaveAttribute('href', '/app/trips')
  })

  it('switching days swaps the visible places', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    renderWorkspace(TOKYO_TRIP.trip.id)
    const day1Place = placesForDay(TOKYO_TRIP, 1)[0].place.name
    const day3Place = placesForDay(TOKYO_TRIP, 3)[0].place.name
    // wait for load
    await screen.findByRole('tab', { name: /day 3/i })
    fireEvent.click(screen.getByRole('tab', { name: /day 3/i }))
    // getAllByText: day 3's narrated title is also the place name (Tokyo Disneyland)
    await waitFor(() => expect(screen.getAllByText(day3Place).length).toBeGreaterThan(0))
    expect(screen.queryByText(day1Place)).not.toBeInTheDocument()
  })

  // Hotel-hub map (plan 2026-08-04-hotel-hub-map, T8). Route ⇄ Hotel is a single segmented
  // control; the mode is observable through each segment's aria-pressed state.
  it('toggles the map layer between route and hotel', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    renderWorkspace(TOKYO_TRIP.trip.id)
    const hotelBtn = await screen.findByRole('button', { name: /^hotel$/i })
    const routeBtn = screen.getByRole('button', { name: /^route$/i })
    expect(routeBtn).toHaveAttribute('aria-pressed', 'true')
    expect(hotelBtn).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(hotelBtn)
    expect(hotelBtn).toHaveAttribute('aria-pressed', 'true')
    expect(routeBtn).toHaveAttribute('aria-pressed', 'false')
  })

  // C5: no hotel got a coordinate ⇒ the hub layer has nothing to draw, so the Hotel segment is
  // disabled rather than flipping to a silently blank map.
  it('disables the hotel layer when no hotel could be placed', async () => {
    const allUnresolved: TripBundle = {
      ...TOKYO_TRIP,
      hotels: TOKYO_TRIP.hotels.map((h) => ({
        ...h, geo_status: 'unresolved' as const, is_recommended: false, rank: null, lat: null, lng: null,
      })),
    }
    getTrip.mockResolvedValueOnce(allUnresolved)
    renderWorkspace(TOKYO_TRIP.trip.id)
    expect(await screen.findByRole('button', { name: /^hotel$/i })).toBeDisabled()
  })

  // Hotel search is OFF (2026-08-30): Travala's MCP endpoint 401s every unauthenticated call, so
  // a trip generated from now on has no hotel rows at all. The gate is the DATA, not a build
  // flag, precisely so the two tests below can both be true at once — a trip generated BEFORE the
  // switch still has real hotel rows in the database, and hiding them would delete visible user
  // data from the UI.
  it('hides the hotel surfaces entirely for a trip with no hotels', async () => {
    getTrip.mockResolvedValueOnce({ ...TOKYO_TRIP, hotels: [] })
    renderWorkspace(TOKYO_TRIP.trip.id)
    // Wait for the bundle, via something that is NOT hotel-related.
    await screen.findByRole('tab', { name: /day 1/i })
    expect(screen.queryByRole('heading', { name: 'Where to stay' })).not.toBeInTheDocument()
    // The whole segmented control goes, not just the Hotel segment: a disabled toggle is still
    // an affordance offering a feature this build does not have.
    expect(screen.queryByRole('group', { name: /map layer/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^hotel$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^route$/i })).not.toBeInTheDocument()
  })

  it('still shows them for a trip that has hotel rows, so old trips keep their data', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    renderWorkspace(TOKYO_TRIP.trip.id)
    expect(await screen.findByRole('heading', { name: 'Where to stay' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: /map layer/i })).toBeInTheDocument()
    expect(screen.getAllByText(TOKYO_TRIP.hotels[0].name).length).toBeGreaterThan(0)
  })

  // Merge-lite (2026-08-06): ONE hotel decision surface. The price-vs-rating card renders exactly
  // once (inside "Where to stay", not also at the top), and the pacing notes render as "Heads up".
  it('renders the price-vs-rating card once, with pacing notes under Heads up', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    renderWorkspace(TOKYO_TRIP.trip.id)
    await screen.findByRole('heading', { name: 'Price vs rating' })
    expect(screen.getAllByRole('heading', { name: 'Price vs rating' })).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Heads up' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Tradeoffs' })).not.toBeInTheDocument()
  })

  it('shows a not-found state for an unknown trip id', async () => {
    getTrip.mockResolvedValueOnce(null)
    renderWorkspace('does_not_exist')
    expect(await screen.findByText(/not found/i)).toBeInTheDocument()
  })

  it('shows the failed state for failed trips', async () => {
    getTrip.mockResolvedValueOnce({ ...TOKYO_TRIP, trip: { ...TOKYO_TRIP.trip, status: 'failed' } })
    renderWorkspace(TOKYO_TRIP.trip.id)
    expect(await screen.findByText(/generation failed/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /plan a new trip/i })).toHaveAttribute('href', '/app')
  })

  it('shows the generating state for in-progress trips', async () => {
    getTrip.mockResolvedValueOnce({ ...TOKYO_TRIP, trip: { ...TOKYO_TRIP.trip, status: 'generating' } })
    renderWorkspace(TOKYO_TRIP.trip.id)
    expect(await screen.findByText(/still generating/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument()
  })

  // Arriving from generation, the relight is mid-flight while this fetch runs. If the
  // loading state took the screen the signature moment would play behind a spinner.
  it('holds the shell map on screen while the trip loads', async () => {
    let settle!: (b: unknown) => void
    getTrip.mockImplementationOnce(() => new Promise((r) => { settle = r }))
    renderWorkspace(TOKYO_TRIP.trip.id)
    await flush()

    expect(screen.getByText(/loading trip/i)).toBeInTheDocument()
    expect(MapCtor).toHaveBeenCalledTimes(1)

    await act(async () => { settle(TOKYO_TRIP) })
    expect(await screen.findByTestId('trip-map')).toBeInTheDocument()
  })

  it('holds the shell map on screen while the trip is still generating', async () => {
    getTrip.mockResolvedValueOnce({ ...TOKYO_TRIP, trip: { ...TOKYO_TRIP.trip, status: 'generating' } })
    renderWorkspace(TOKYO_TRIP.trip.id)
    await screen.findByText(/still generating/i)
    await flush()

    expect(MapCtor).toHaveBeenCalledTimes(1)
  })

  // Nothing to map once the trip turns out to be missing, so the map is dropped again
  // rather than left glowing behind a dead end.
  it('drops the map when the trip turns out to be missing', async () => {
    let settle!: (b: unknown) => void
    getTrip.mockImplementationOnce(() => new Promise((r) => { settle = r }))
    renderWorkspace('does_not_exist')
    await flush()
    fireLoad()
    expect(screen.getByTestId('shared-map')).toHaveClass('shared-map--visible')

    await act(async () => { settle(null) })
    await flush()
    expect(screen.getByTestId('shared-map')).not.toHaveClass('shared-map--visible')
  })

  // Feedback mount (plan T3). The panel appears ONLY on the explicit allowlist — completed
  // surfaces plus the failed screen — never on whatever status merely reaches the main return.
  // TOKYO_TRIP itself is `saved_with_gaps`, so `complete` has to be seeded explicitly.
  function bundleWith(status: TripBundle['trip']['status']): TripBundle {
    return { ...TOKYO_TRIP, trip: { ...TOKYO_TRIP.trip, status } }
  }

  it('mounts the feedback panel on complete trips', async () => {
    getTrip.mockResolvedValueOnce(bundleWith('complete'))
    renderWorkspace(TOKYO_TRIP.trip.id)
    expect(await screen.findByTestId('trip-feedback-panel')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /how was this trail/i })).toBeInTheDocument()
  })

  it('mounts the feedback panel on saved_with_gaps trips', async () => {
    getTrip.mockResolvedValueOnce(bundleWith('saved_with_gaps'))
    renderWorkspace(TOKYO_TRIP.trip.id)
    expect(await screen.findByTestId('trip-feedback-panel')).toBeInTheDocument()
  })

  // places_ready falls THROUGH to the normal workspace return, so this proves the gate is an
  // explicit allowlist, not "whatever reaches the main return".
  it('hides the feedback panel on places_ready trips', async () => {
    getTrip.mockResolvedValueOnce(bundleWith('places_ready'))
    renderWorkspace(TOKYO_TRIP.trip.id)
    await screen.findByRole('link', { name: /all trails/i })
    expect(screen.queryByTestId('trip-feedback-panel')).not.toBeInTheDocument()
  })

  it('mounts the feedback panel on the failed screen, beside the failure copy', async () => {
    getTrip.mockResolvedValueOnce(bundleWith('failed'))
    renderWorkspace(TOKYO_TRIP.trip.id)
    expect(await screen.findByText(/generation failed/i)).toBeInTheDocument()
    expect(screen.getByText(/tell us what went wrong/i)).toBeInTheDocument()
    expect(screen.getByTestId('trip-feedback-panel')).toBeInTheDocument()
  })

  it('hides the feedback panel while generating', async () => {
    getTrip.mockResolvedValueOnce(bundleWith('generating'))
    renderWorkspace(TOKYO_TRIP.trip.id)
    await screen.findByText(/still generating/i)
    expect(screen.queryByTestId('trip-feedback-panel')).not.toBeInTheDocument()
  })

  it('hides the feedback panel while draft', async () => {
    getTrip.mockResolvedValueOnce(bundleWith('draft'))
    renderWorkspace(TOKYO_TRIP.trip.id)
    await screen.findByText(/still generating/i)
    expect(screen.queryByTestId('trip-feedback-panel')).not.toBeInTheDocument()
  })

  // Codex r1 low: the panel binds to the LOADED bundle's trip id, never the route param.
  it('passes the loaded bundle trip id to the panel, not the route param', async () => {
    getTrip.mockResolvedValueOnce({ ...TOKYO_TRIP, trip: { ...TOKYO_TRIP.trip, id: 'bundle-trip-id' } })
    renderWorkspace('route-param-id')
    expect(await screen.findByTestId('trip-feedback-panel')).toHaveTextContent('bundle-trip-id')
  })
})

/**
 * The seeded (read-only sample) path — `/app/trip/demo`.
 *
 * A judge must be able to see a real 3D trail with no account, no generation and no spend, so
 * the workspace accepts a bundle directly instead of fetching one. Nothing here has a database
 * row behind it, which is what the read-only half is about: no feedback composer to post into a
 * trip that does not exist, and a label that tells the agent the same thing.
 */
describe('TripWorkspace seeded with a bundle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN = 'pk.test'
  })
  afterEach(() => { delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN })

  function renderSeeded(extra: { readOnly?: boolean } = {}) {
    return render(
      <MapProvider>
        <TripWorkspace tripId={TOKYO_TRIP.trip.id} bundle={TOKYO_TRIP} {...extra} />
      </MapProvider>,
    )
  }

  it('renders the bundle it was given without ever fetching', async () => {
    renderSeeded()
    expect(await screen.findByText(placesForDay(TOKYO_TRIP, 1)[0].place.name)).toBeInTheDocument()
    expect(await screen.findByTestId('trip-map')).toBeInTheDocument()
    expect(getTrip).not.toHaveBeenCalled()
  })

  // The fetch path is the one every real trip still takes; the prop must not have moved it.
  it('leaves the fetching path alone when no bundle is passed', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    renderWorkspace(TOKYO_TRIP.trip.id)
    await screen.findByTestId('trip-map')
    expect(getTrip).toHaveBeenCalledWith(TOKYO_TRIP.trip.id)
  })

  it('labels the read-only sample so the agent is not set up to fail', async () => {
    renderSeeded({ readOnly: true })
    expect(await screen.findByText(/sample trail — read-only/i)).toBeInTheDocument()
  })

  it('does not label an ordinary trip read-only', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    renderWorkspace(TOKYO_TRIP.trip.id)
    await screen.findByTestId('trip-map')
    expect(screen.queryByText(/sample trail — read-only/i)).not.toBeInTheDocument()
  })

  // TOKYO_TRIP is `saved_with_gaps`, which is on the composer's allowlist — so this is the gate
  // doing work, not the status. There is no trip row for feedback to reference.
  it('keeps the feedback composer off the sample', async () => {
    renderSeeded({ readOnly: true })
    await screen.findByRole('link', { name: /all trails/i })
    expect(screen.queryByTestId('trip-feedback-panel')).not.toBeInTheDocument()
  })

  it('still mounts the feedback composer on a seeded trip that is not read-only', async () => {
    renderSeeded()
    expect(await screen.findByTestId('trip-feedback-panel')).toBeInTheDocument()
  })
})

describe('arriving from a generation the shell just finished', () => {
  /* The last complaint from the first real run: "the transition to the complete page is not
     obvious — it will go back to the home page then only show the complete trip."

     There is no bounce through the home page. What he saw is this component: the shell pushes
     /app/trip/{id} the instant the result frame lands, and this page then reads the bundle
     client-side. For that whole round-trip it rendered a bare centred "Loading trip…" pill over
     the shared dawn map — the rail, the sidebar and every other thing framing the previous screen
     gone at once, leaving an empty map with one small label on it. That is a different page as
     far as anyone waiting is concerned.

     So when the run that just completed IS this trip, the frame continues the rail instead of
     replacing it: the same astronaut, the same words the rail ended on, and a dot that says the
     page is still working. The claim is backed — `complete` is set only from a result frame whose
     verdict was success, which is also the only verdict that navigates here — and it is confined
     to the one state where the outcome is still open. */
  let emit: ((e: StreamEvent) => void) | null = null

  function ArrivalHarness(
    { tripId, runTripId, seeded }: { tripId: string; runTripId: string; seeded?: boolean },
  ) {
    const api = useGeneration()
    const started = useRef(false)
    if (!started.current) {
      started.current = true
      api.reserve()?.begin(runTripId)
    }
    return <TripWorkspace tripId={tripId} bundle={seeded ? TOKYO_TRIP : undefined} readOnly={seeded} />
  }

  async function arrive({ runTripId = TOKYO_TRIP.trip.id, tripId = TOKYO_TRIP.trip.id } = {}) {
    const openStream = vi.fn((_id: string, _tok: string, onEvent: (e: StreamEvent) => void) => {
      emit = onEvent
      return { cancel: vi.fn() }
    })
    const view = render(
      <MapProvider>
        <GenerationProvider openStream={openStream as never} readToken={async () => 'tok'}>
          <ArrivalHarness tripId={tripId} runTripId={runTripId} />
        </GenerationProvider>
      </MapProvider>,
    )
    await flush()
    return view
  }

  async function finishRun(tripId = TOKYO_TRIP.trip.id) {
    await act(async () => {
      emit?.({ type: 'result', content: JSON.stringify({ trip_id: tripId, status: 'complete' }) })
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    emit = null
    process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN = 'pk.test'
    // The read never settles: every assertion below runs while the outcome is genuinely open,
    // which is the only state this frame is allowed to appear in.
    getTrip.mockReturnValue(new Promise(() => {}))
  })
  afterEach(() => { delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN })

  it('continues the rail instead of blanking to a bare loading pill', async () => {
    await arrive()
    await finishRun()

    const arrival = screen.getByTestId('trip-arrival')
    expect(arrival).toHaveTextContent(/your trip is ready/i)
    expect(arrival).toHaveTextContent(/opening your map/i)
    expect(arrival.querySelector('[data-mascot="astronaut"]')).not.toBeNull()
    expect(arrival.querySelector('.pulse-dot--live')).not.toBeNull()
  })

  it('says nothing optimistic when the trip was opened cold', async () => {
    // No run to continue from — a link, the trails list, a reload. There is no evidence this
    // trip is ready, so the frame does not claim it is.
    render(
      <MapProvider>
        <TripWorkspace tripId={TOKYO_TRIP.trip.id} />
      </MapProvider>,
    )
    await flush()

    expect(screen.queryByTestId('trip-arrival')).toBeNull()
    expect(screen.getByText(/loading trip/i)).toBeInTheDocument()
  })

  it('does not carry a finished run onto a DIFFERENT trip page', async () => {
    await arrive({ runTripId: 'trip_other', tripId: TOKYO_TRIP.trip.id })
    await finishRun('trip_other')

    expect(screen.queryByTestId('trip-arrival')).toBeNull()
    expect(screen.getByText(/loading trip/i)).toBeInTheDocument()
  })

  it('will not call a FAILED run ready, even for this very trip', async () => {
    /* Reachable without a push: the shell holds the run for the whole session, so a user who
       opens this trip from their trails list after a failure arrives with a terminal run for
       exactly this id sitting in the shell. "Terminal" is not the test — the verdict is. A frame
       promising a ready trip in front of a generation that died is a worse lie than the bare
       pill it replaced. */
    await arrive()
    await act(async () => {
      emit?.({ type: 'result', content: JSON.stringify({ trip_id: TOKYO_TRIP.trip.id, error: 'no places' }) })
      await Promise.resolve()
    })

    expect(screen.queryByTestId('trip-arrival')).toBeNull()
    expect(screen.getByText(/loading trip/i)).toBeInTheDocument()
  })

  it('cannot flash on /app/trip/demo, which is fixture-backed and never loads', async () => {
    /* The demo route hands this component the Tokyo fixture, so `status` starts at 'ready' and
       the effect returns before it could ever be set to 'loading' — the arrival frame is
       unreachable there by construction. Asserted with a completed run for that very trip id,
       which is the only way the frame could otherwise appear, because that route is the one a
       judge opens with no account and a flash of "opening your map" on a page that was already
       on screen would be the regression that matters most. */
    render(
      <MapProvider>
        <GenerationProvider openStream={vi.fn() as never} readToken={async () => 'tok'}>
          <ArrivalHarness tripId={TOKYO_TRIP.trip.id} runTripId={TOKYO_TRIP.trip.id} seeded />
        </GenerationProvider>
      </MapProvider>,
    )
    await flush()

    expect(screen.queryByTestId('trip-arrival')).toBeNull()
    expect(screen.getByText(placesForDay(TOKYO_TRIP, 1)[0].place.name)).toBeInTheDocument()
    expect(getTrip).not.toHaveBeenCalled()
  })

  it('is gone the moment the outcome stops being open', async () => {
    // The frame is confined to `status === 'loading'`. A read that answers "no such trip" must
    // land on "Trip not found", never on a screen still promising a trip that is ready.
    let settle!: (b: TripBundle | null) => void
    getTrip.mockReturnValue(new Promise((resolve) => { settle = resolve }))
    await arrive()
    await finishRun()
    expect(screen.getByTestId('trip-arrival')).toBeInTheDocument()

    await act(async () => { settle(null); await Promise.resolve() })
    expect(screen.queryByTestId('trip-arrival')).toBeNull()
    expect(screen.getByText(/trip not found/i)).toBeInTheDocument()
  })
})

/* Every itinerary edit now starts a ~30 s summary rewrite by itself (GlobalTools::runReplan).
   For those 30 seconds the persisted day prose describes the trip BEFORE the edit — it is not
   wrong text, it is true text about an itinerary that no longer exists. The activity rail was
   the only surface saying so, and a reader of the itinerary panel had no way to know the
   sentence under their eyes was about to be replaced. */
describe('TripWorkspace summary rewrite marker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN = 'pk.test'
  })
  afterEach(() => { delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN })

  it('marks the day prose as updating while a rewrite runs, and clears it when it lands', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    const { reg } = renderWorkspaceWithRegistry(TOKYO_TRIP.trip.id)
    await waitFor(() => expect(document.querySelector('[data-place-id]')).not.toBeNull())

    expect(screen.queryByTestId('summary-rewriting')).toBeNull()

    let id = 0
    act(() => { id = reg.current!.beginActivity('replan_trip') })
    expect(screen.getByTestId('summary-rewriting')).toBeInTheDocument()

    act(() => { reg.current!.endActivity(id, 'done', 'Rewrote 3 day summaries.') })
    expect(screen.queryByTestId('summary-rewriting')).toBeNull()
  })

  /* A failed rewrite leaves the prose stale FOREVER, but nothing is coming to replace it — so
     "updating" would be a standing lie. The marker follows the running entry, not staleness. */
  it('clears the marker when the rewrite fails, not only when it succeeds', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    const { reg } = renderWorkspaceWithRegistry(TOKYO_TRIP.trip.id)
    await waitFor(() => expect(document.querySelector('[data-place-id]')).not.toBeNull())

    let id = 0
    act(() => { id = reg.current!.beginActivity('replan_trip') })
    expect(screen.getByTestId('summary-rewriting')).toBeInTheDocument()
    act(() => { reg.current!.endActivity(id, 'failed', 'Could not rewrite.') })
    expect(screen.queryByTestId('summary-rewriting')).toBeNull()
  })

  /* The stops are NOT stale after an edit — they refresh with it. Marking the timeline would
     say the opposite of what is true, so the marker is scoped to the prose. */
  it('does not mark the stop list, only the prose', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    const { reg } = renderWorkspaceWithRegistry(TOKYO_TRIP.trip.id)
    await waitFor(() => expect(document.querySelector('[data-place-id]')).not.toBeNull())

    act(() => { reg.current!.beginActivity('replan_trip') })
    const marker = screen.getByTestId('summary-rewriting')
    expect(marker.closest('ol')).toBeNull()
    expect(document.querySelector('[data-place-id]')!.closest('li')!).not.toContainElement(marker)
  })

  /* Any other tool running is not a summary rewrite. A marker that lit up for `get_itinerary`
     would tell the user their prose is changing every time the agent reads the page. */
  it('ignores activity from other tools', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    const { reg } = renderWorkspaceWithRegistry(TOKYO_TRIP.trip.id)
    await waitFor(() => expect(document.querySelector('[data-place-id]')).not.toBeNull())

    act(() => { reg.current!.beginActivity('get_itinerary') })
    expect(screen.queryByTestId('summary-rewriting')).toBeNull()
  })
})

/* The covers are the panel's, but the BUNDLE is the workspace's — `thumbnailFor` needs it and
   ItineraryCards is only handed a day's stops. Without this wiring every stop draws the
   no-cover placeholder and the omission is invisible in the panel's own suite. */
describe('TripWorkspace itinerary covers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN = 'pk.test'
  })
  afterEach(() => { delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN })

  it('hands the bundle to the itinerary so reel covers can render', async () => {
    getTrip.mockResolvedValueOnce(TOKYO_TRIP)
    renderWorkspace(TOKYO_TRIP.trip.id)
    await waitFor(() => expect(document.querySelector('[data-place-id]')).not.toBeNull())

    const covered = placesForDay(TOKYO_TRIP, 1).filter((tp) => thumbnailFor(TOKYO_TRIP, tp))
    expect(covered.length, 'day 1 has no reel-covered stop — this test proves nothing').toBeGreaterThan(0)
    for (const tp of covered) {
      const card = document.querySelector<HTMLElement>(`[data-place-id="${tp.place_id}"]`)!
      expect(card.querySelector('img')).toHaveAttribute('src', thumbnailFor(TOKYO_TRIP, tp))
    }
  })
})
