import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import type { StreamEvent } from '@/lib/trip/backend-types'
import MapProvider from '@/components/map/MapProvider'
import GenerationScene from '@/components/create/GenerationScene'

const { mapInstance, MapCtor, MarkerCtor, markerElements, getTrip } = vi.hoisted(() => {
  const handler = () => ({ enable: vi.fn(), disable: vi.fn() })
  const mapInstance = {
    on: vi.fn(),
    setConfigProperty: vi.fn(), fitBounds: vi.fn(),
    remove: vi.fn(), resize: vi.fn(), stop: vi.fn(),
    style: { setTransition: vi.fn() },
    scrollZoom: handler(), boxZoom: handler(), dragRotate: handler(), dragPan: handler(),
    keyboard: handler(), doubleClickZoom: handler(), touchZoomRotate: handler(), touchPitch: handler(),
  }
  const markerElements: HTMLElement[] = []
  const addedTo: unknown[] = []
  const MarkerCtor = vi.fn((options: { element: HTMLElement }) => {
    markerElements.push(options.element)
    const marker = {
      setLngLat: vi.fn(() => marker),
      addTo: vi.fn((m: unknown) => { addedTo.push(m); return marker }),
      remove: vi.fn(),
      addedTo,
    }
    return marker
  })
  return {
    mapInstance,
    MapCtor: vi.fn(() => mapInstance),
    MarkerCtor,
    markerElements,
    getTrip: vi.fn(),
  }
})

vi.mock('mapbox-gl', () => ({
  default: {
    Map: MapCtor,
    Marker: MarkerCtor,
    LngLatBounds: vi.fn(() => ({ extend: vi.fn() })),
    accessToken: '',
  },
}))
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}))
vi.mock('@/lib/trip/supabase-api', () => ({ getTrip }))

function fireLoad() {
  const load = mapInstance.on.mock.calls.find((c) => c[0] === 'load')
  act(() => { (load?.[1] as () => void)?.() })
}

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

const PLACES_READY: StreamEvent[] = [{ type: 'stage', stage: 'dedup', msg: 'deduping' }]

function renderScene(events: StreamEvent[] = [], tripId: string | null = 'trip_tokyo_demo') {
  return render(
    <MapProvider>
      <GenerationScene tripId={tripId} events={events} />
    </MapProvider>,
  )
}

describe('GenerationScene', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    markerElements.length = 0
    getTrip.mockResolvedValue(TOKYO_TRIP)
    process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN = 'pk.test'
  })
  afterEach(() => { delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN })

  // It must not build its own map: an instance it owned would die with this component,
  // which is exactly what made the night->dawn relight impossible.
  it('drives the shell map at the night preset instead of constructing its own', async () => {
    renderScene()
    await flush()
    fireLoad()

    expect(MapCtor).toHaveBeenCalledTimes(1)
    expect(mapInstance.setConfigProperty).toHaveBeenCalledWith('basemap', 'lightPreset', 'night')
  })

  it('leaves the map inert — this scene is a backdrop, not something to fly around', async () => {
    renderScene()
    await flush()

    expect(mapInstance.dragPan.disable).toHaveBeenCalled()
    expect(mapInstance.scrollZoom.disable).toHaveBeenCalled()
    expect(mapInstance.dragPan.enable).not.toHaveBeenCalled()
    expect(mapInstance.scrollZoom.enable).not.toHaveBeenCalled()
  })

  it('lands pins on the shared instance once a places-bearing stage fires', async () => {
    renderScene(PLACES_READY)
    await flush()
    fireLoad()
    await flush()

    expect(getTrip).toHaveBeenCalledWith('trip_tokyo_demo')
    expect(markerElements).toHaveLength(TOKYO_TRIP.places.length)
    expect(markerElements[0]).toHaveClass('pin-land')
    const marker = MarkerCtor.mock.results[0]?.value as { addedTo: unknown[] }
    expect(marker.addedTo[0]).toBe(mapInstance)
    expect(mapInstance.fitBounds).toHaveBeenCalled()
  })

  it('does not fetch places before a places-bearing stage', async () => {
    renderScene([{ type: 'stage', stage: 'scrape', msg: 'scraping' }])
    await flush()
    fireLoad()
    await flush()

    expect(getTrip).not.toHaveBeenCalled()
  })

  it('narrates over the starfield when no token is configured', async () => {
    delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN
    const { container } = renderScene(PLACES_READY)
    await flush()

    expect(MapCtor).not.toHaveBeenCalled()
    expect(container.querySelector('.hero-field')).not.toBeNull()
    expect(screen.getByText(/deduping/i)).toBeInTheDocument()
  })
})

describe('the progress genbar under concurrent stages', () => {
  /* runner.py gathers transport/restaurants/hotels/narration and each records its `stage` event
     as its first statement, so the dispatch events themselves arrive out of STAGE_ORDER:
     transport is index 11, restaurants 9. Reading the LAST stage event verbatim rewinds the bar,
     which reads to a waiting user as the run losing ground. Completions are `decision` events and
     must not move the bar at all — they report finished work, not a new pipeline position. */
  const fill = () => screen.getByTestId('genbar-fill').style.width

  it('does not rewind on the real dispatch order the gather produces', () => {
    renderScene([
      { type: 'stage', stage: 'transport', msg: 'Working out how to get between stops' },
      { type: 'stage', stage: 'restaurants', msg: 'Looking for places to eat' },
    ])
    // transport (index 11) → 80%; restaurants (index 9) would drag it back to 67%.
    expect(fill()).toBe('80%')
  })

  it('advances for a genuinely later stage but never regresses afterwards', () => {
    renderScene([
      { type: 'stage', stage: 'summarize', msg: 'Writing your day summaries' },
      { type: 'stage', stage: 'restaurants', msg: 'Looking for places to eat' },
      { type: 'stage', stage: 'hotels', msg: 'Looking for somewhere to stay' },
    ])
    expect(fill()).toBe('93%')
  })

  it('is not moved by a completion — a decision reports finished work, not position', () => {
    renderScene([
      { type: 'stage', stage: 'restaurants', msg: 'Looking for places to eat' },
      { type: 'decision', stage: 'summarize', msg: 'Wrote summaries for 3 days' },
    ])
    // summarize is index 13, but it arrived as a decision: the bar stays at restaurants.
    expect(fill()).toBe('67%')
  })

  it('holds the 5% floor when no stage in this build is recognised', () => {
    renderScene([{ type: 'stage', stage: 'not_a_real_stage' as never, msg: 'from a newer backend' }])
    expect(fill()).toBe('5%')
  })

  it('a result wins over every stage position', () => {
    renderScene([
      { type: 'stage', stage: 'scrape', msg: 'Reading Reels' },
      { type: 'result', content: '{}' },
    ])
    expect(fill()).toBe('100%')
  })
})

describe('landing pins during the generation', () => {
  /* The scene fetched places on the first places-bearing stage and latched the ref BEFORE the
     fetch resolved. `dedup` is emitted at runner.py:332 but persist_itinerary does not run until
     :391 - even `stage:save` (:386) precedes it - so that first read found zero rows and the
     latch permanently suppressed every retry. Pins have never landed progressively.
     The honest trigger is the post-persistence `decision` on `save`. */
  beforeEach(() => {
    vi.clearAllMocks()
    markerElements.length = 0
    process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN = 'pk.test'
  })
  afterEach(() => { delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN })

  const SAVED: StreamEvent = { type: 'decision', stage: 'save', msg: 'Saved 8 stops to your map' }
  const DEDUP: StreamEvent = { type: 'stage', stage: 'dedup', msg: 'deduping' }

  it('does not give up when the first read is too early', async () => {
    getTrip.mockResolvedValueOnce({ ...TOKYO_TRIP, places: [] })   // dedup: nothing saved yet
    getTrip.mockResolvedValue(TOKYO_TRIP)                          // after persistence
    const { rerender } = renderScene([DEDUP])
    await flush()
    fireLoad()
    await flush()
    expect(getTrip).toHaveBeenCalledTimes(1)
    expect(markerElements).toHaveLength(0)

    rerender(
      <MapProvider>
        <GenerationScene tripId="trip_tokyo_demo" events={[DEDUP, SAVED]} />
      </MapProvider>,
    )
    await flush()
    expect(markerElements).toHaveLength(TOKYO_TRIP.places.length)
  })

  /* The sequential test above waits for read one to RESOLVE before the second signal arrives,
     so it only ever proves sequential retry. The failure that actually happens is the overlap:
     runner.py fires the post-persistence `decision:save` and then dispatches transport,
     restaurants, hotels and summarize within milliseconds, so the next signal lands while the
     save-triggered read is still open. Cleanup cancelled that read, the new effect run saw
     `inFlightRef` and returned, and the ref clearing in `finally` neither rendered nor re-ran
     the effect — so nothing was ever scheduled again and the pins never landed. */
  it('retries when the next signal arrives BEFORE the first read resolves', async () => {
    let resolveFirstRead!: (bundle: unknown) => void
    // Deliberately never resolved until this test says so: every assertion until then runs
    // while read one is genuinely open, which is the whole point of this case.
    getTrip.mockReturnValueOnce(new Promise((resolve) => { resolveFirstRead = resolve }))
    getTrip.mockResolvedValue(TOKYO_TRIP)

    const { rerender } = renderScene([DEDUP])
    await flush()
    fireLoad()
    await flush()
    expect(getTrip).toHaveBeenCalledTimes(1)
    expect(markerElements).toHaveLength(0)      // read one is open: nothing has resolved it

    // Signal two, mid-flight. No await of read one stands between it and the render above.
    rerender(
      <MapProvider>
        <GenerationScene tripId="trip_tokyo_demo" events={[DEDUP, SAVED]} />
      </MapProvider>,
    )
    await flush()
    expect(getTrip).toHaveBeenCalledTimes(1)    // still the SAME open read — proof of overlap
    expect(markerElements).toHaveLength(0)

    // Read one answers what a pre-persistence read honestly returns: nothing. Only a retry
    // can land pins from here, so markers below cannot come from the cancelled attempt.
    await act(async () => { resolveFirstRead({ ...TOKYO_TRIP, places: [] }) })
    await flush()

    expect(getTrip).toHaveBeenCalledTimes(2)
    expect(markerElements).toHaveLength(TOKYO_TRIP.places.length)
  })

  it('lands pins once and does not re-land them on later events', async () => {
    getTrip.mockResolvedValue(TOKYO_TRIP)
    const { rerender } = renderScene([SAVED])
    await flush()
    fireLoad()
    await flush()
    expect(markerElements).toHaveLength(TOKYO_TRIP.places.length)

    rerender(
      <MapProvider>
        <GenerationScene tripId="trip_tokyo_demo" events={[
          SAVED, { type: 'stage', stage: 'hotels', msg: 'Looking for somewhere to stay' },
        ]} />
      </MapProvider>,
    )
    await flush()
    expect(markerElements).toHaveLength(TOKYO_TRIP.places.length)
  })
})
