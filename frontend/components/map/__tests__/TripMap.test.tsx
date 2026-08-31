import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import { TOKYO_TRIP_WITH_HOTELS } from '@/lib/trip/fixtures/tokyo-hotels'
import { markTripFramed } from '@/lib/trip/map-handoff'
import MapProvider from '@/components/map/MapProvider'
import TripMap from '@/components/map/TripMap'

const {
  mapInstance, MapCtor, MarkerCtor, PopupCtor, BoundsCtor, markerElements, popupElements,
} = vi.hoisted(() => {
  const handler = () => ({ enable: vi.fn(), disable: vi.fn() })
  const mapInstance = {
    on: vi.fn(), off: vi.fn(), getZoom: vi.fn(() => 13),
    // Framing measures the CANVAS, not the window: padding derived from window height once
    // exceeded a phone's canvas, and Mapbox responds by abandoning the camera move entirely.
    getCanvas: vi.fn(() => ({ clientWidth: 1440, clientHeight: 900 })),
    addSource: vi.fn(), addLayer: vi.fn(),
    getSource: vi.fn((_id?: string) => undefined), getLayer: vi.fn((_id?: string) => undefined),
    removeLayer: vi.fn(), removeSource: vi.fn(),
    flyTo: vi.fn(), fitBounds: vi.fn(), setConfigProperty: vi.fn(),
    remove: vi.fn(), resize: vi.fn(), stop: vi.fn(),
    style: { setTransition: vi.fn() },
    scrollZoom: handler(), boxZoom: handler(), dragRotate: handler(), dragPan: handler(),
    keyboard: handler(), doubleClickZoom: handler(), touchZoomRotate: handler(), touchPitch: handler(),
  }
  const MapCtor = vi.fn(() => mapInstance)
  const markerElements: HTMLElement[] = []
  const MarkerCtor = vi.fn((options: { element: HTMLElement }) => {
    markerElements.push(options.element)
    const marker = {
      setLngLat: vi.fn(() => marker), addTo: vi.fn(() => marker), remove: vi.fn(),
    }
    return marker
  })
  const popupElements: HTMLElement[] = []
  const PopupCtor = vi.fn(() => {
    const popup = {
      setLngLat: vi.fn(() => popup),
      setDOMContent: vi.fn((element: HTMLElement) => {
        popupElements.push(element)
        return popup
      }),
      addTo: vi.fn(() => popup),
      remove: vi.fn(),
    }
    return popup
  })
  const BoundsCtor = vi.fn(() => ({ extend: vi.fn() }))
  return { mapInstance, MapCtor, MarkerCtor, PopupCtor, BoundsCtor, markerElements, popupElements }
})

vi.mock('mapbox-gl', () => ({
  default: {
    Map: MapCtor, Marker: MarkerCtor, Popup: PopupCtor, LngLatBounds: BoundsCtor, accessToken: '',
  },
}))
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}))

function fireLoad() {
  const load = mapInstance.on.mock.calls.find((c) => c[0] === 'load')
  act(() => { (load?.[1] as () => void)?.() })
}

async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

function renderMap(props: Partial<Parameters<typeof TripMap>[0]> = {}) {
  return render(
    <MapProvider>
      <TripMap
        bundle={TOKYO_TRIP}
        activeDayNumber={1}
        selectedPlaceId={null}
        onSelectPlace={() => {}}
        {...props}
      />
    </MapProvider>,
  )
}

// The trail upgrades each same-day hop to the leg's road geometry (selectors.trailCoordinates),
// so the expectations below derive the interior points from the fixture rather than hardcoding
// floats. Expected is assembled by a DIFFERENT expression than the implementation (explicit
// literals + slices vs. a loop over the legs), so it is not circular.
const geomOf = (id: string) =>
  TOKYO_TRIP.transport_legs.find((l) => l.id === id)!.route_geometry!.coordinates

function trailFeatures(): { properties: { day_number: number; color: string }; geometry: { coordinates: number[][] } }[] {
  const call = mapInstance.addSource.mock.calls.find((c) => c[0] === 'trip-trail')
  return (call![1] as {
    data: { features: { properties: { day_number: number; color: string }; geometry: { coordinates: number[][] } }[] }
  }).data.features
}

function trailCoords(): number[][] {
  return trailFeatures().flatMap((feature, index) =>
    index === 0 ? feature.geometry.coordinates : feature.geometry.coordinates.slice(1))
}

describe('TripMap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    markerElements.length = 0
    popupElements.length = 0
    process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN = 'pk.test'
    // Framing is scheduled via requestAnimationFrame (so a Strict Mode remount /
    // generation handoff can't cancel the fit — see TripMap). Run it synchronously
    // here so these effect assertions observe the framing without a frame wait.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN
    vi.unstubAllGlobals()
  })

  // It drives the shell's instance rather than building one, so the map arriving from
  // generation is the same object — that is what lets it relight instead of restart.
  it('drives the shared map at the dawn preset instead of constructing its own', async () => {
    renderMap()
    await flush()
    fireLoad()

    expect(MapCtor).toHaveBeenCalledTimes(1)
    expect(mapInstance.setConfigProperty).toHaveBeenCalledWith('basemap', 'lightPreset', 'dawn')
  })

  it('anchors wheel zoom to the map center so pins do not follow the cursor', async () => {
    renderMap()
    await flush()

    expect(mapInstance.scrollZoom.enable).toHaveBeenCalledWith({ around: 'center' })
  })

  // With one persistent instance the camera no longer resets on navigation, so the trip
  // view has to frame its own places rather than inherit the generation globe.
  it('anchors the teardrop by its tip, not its middle', async () => {
    // anchor:'bottom' is what puts the point ON the coordinate. The default 'center' floats the
    // whole pin half its height above the place it claims to mark.
    renderMap()
    await flush()
    fireLoad()
    await flush()
    // Trail pins only. An eat marker is a round chip, and a circle's ANCHOR IS ITS CENTRE —
    // bottom-anchoring one would float it above the restaurant it marks. Different shape,
    // different correct anchor; asserting "every marker" conflated the two.
    const trailMarkers = MarkerCtor.mock.calls
      .map((c) => c[0] as { element: HTMLElement, anchor?: string })
      .filter((o) => o?.element?.classList.contains('constellation-pin'))
    expect(trailMarkers.length).toBeGreaterThan(0)
    expect(trailMarkers.every((o) => o.anchor === 'bottom')).toBe(true)
  })

  it('keeps the stop number visible even when the pin carries a photo', async () => {
    renderMap()
    await flush()
    fireLoad()
    await flush()
    const marker = markerElements.find((e) => e.getAttribute('aria-label') === 'Akasaka Station')!
    const n = marker.querySelector('.constellation-pin__drop-number')?.textContent
      ?? marker.querySelector('.constellation-pin__badge')?.textContent
    expect(n).toBe('1')
  })

  it('never asks for more padding than the canvas can give', async () => {
    // The bug: framePadding derived `bottom` from window.innerHeight (394px on a phone) and
    // applied it to a shorter canvas. Mapbox logs "Map cannot fit within canvas with the given
    // bounds, padding, and/or offset" and REFUSES TO MOVE — so a Tokyo trip opened on mobile
    // showed the default globe over the Indian Ocean, silently.
    mapInstance.getCanvas.mockReturnValue({ clientWidth: 390, clientHeight: 380 })
    renderMap()
    await flush()
    fireLoad()
    await flush()
    expect(mapInstance.fitBounds).toHaveBeenCalled()
    const pad = mapInstance.fitBounds.mock.calls.at(-1)![1].padding
    expect(pad.top + pad.bottom).toBeLessThan(380)
    expect(pad.left + pad.right).toBeLessThan(390)
  })

  it('refuses a hostile Reel thumbnail rather than rendering it', async () => {
    // thumbnail_url arrives from Apify's scrape of Instagram — attacker-controlled third-party
    // content (guardrail #11). The popup already routes its copy through safeWebUrl; the pin's
    // <image href> is the same value and must clear the same check, or the two disagree about
    // what is safe to load. Falling back to the placeholder is the correct degradation.
    const hostile = {
      ...TOKYO_TRIP,
      inspiration: TOKYO_TRIP.inspiration.map((i, idx) =>
        idx === 0 ? { ...i, thumbnail_url: 'javascript:alert(1)' } : i),
    }
    render(
      <MapProvider>
        <TripMap bundle={hostile} activeDayNumber={1} selectedPlaceId={null} onSelectPlace={() => {}} />
      </MapProvider>,
    )
    await flush()
    fireLoad()
    await flush()

    const marker = markerElements.find((e) => e.getAttribute('aria-label') === 'Akasaka Station')!
    expect(marker.querySelector('image')).toBeNull()
    expect(marker.querySelector('.constellation-pin__placeholder')).not.toBeNull()
    // And nothing anywhere on the map smuggled the string through.
    expect(markerElements.some((e) => e.innerHTML.includes('javascript:'))).toBe(false)
  })

  it('leaves room below a selected place for its popup', async () => {
    // Mapbox picks a popup anchor by asking "is there room ABOVE?" before "is there room
    // BELOW?", and when neither fits it falls through to placing the popup below and overflows
    // the canvas. Centring the selected place on a 720px-tall laptop canvas is exactly that
    // case: a ~395px evidence popup fits in neither direction, so the CTAs fell off-screen.
    // Fixed at the camera — land the pin high — so assert the pin's resulting screen position
    // rather than the padding numbers, which is what actually has to hold.
    const H = 720
    mapInstance.getCanvas.mockReturnValue({ clientWidth: 1280, clientHeight: H })
    const view = renderMap()
    await flush()
    fireLoad()
    await flush()
    // Select AFTER load: the effect keys on [selectedPlaceId], so a selection present at mount
    // resolves before the map is ready and never flies. This is how the app reaches it too.
    mapInstance.flyTo.mockClear()
    view.rerender(
      <MapProvider>
        <TripMap bundle={TOKYO_TRIP} activeDayNumber={1} selectedPlaceId="pl_akasaka" onSelectPlace={() => {}} />
      </MapProvider>,
    )
    await flush()

    const pad = mapInstance.flyTo.mock.calls.at(-1)![0].padding
    // Centre of the padded viewport, which is where flyTo lands the place.
    const pinY = pad.top + (H - pad.top - pad.bottom) / 2
    expect(pinY).toBeLessThan(H / 3)          // upper third, so a popup has somewhere to go
    expect(pad.top + pad.bottom).toBeLessThan(H)   // and never so greedy Mapbox abandons the fit
  })

  it('trusts a zero-sized canvas measurement instead of substituting the window', async () => {
    // `canvas?.clientHeight || window.innerHeight` treated a real 0 as "not measured" and
    // substituted the much larger window — recreating the padding/canvas mismatch the 70% cap
    // exists to prevent, in the transient mid-layout case. A zero canvas must yield zero pads.
    mapInstance.getCanvas.mockReturnValue({ clientWidth: 0, clientHeight: 0 })
    renderMap()
    await flush()
    fireLoad()
    await flush()

    const pad = mapInstance.fitBounds.mock.calls.at(-1)![1].padding
    expect(pad).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
  })

  // "Where to eat" was a list you could read but not locate. The markers DID exist — an 8px
  // cream dot whose name only appeared on :hover — which on a dense street map beside 40x52
  // photo teardrops is invisible, and on a touch device is unreachable, since there is no hover.
  // The shared fixture cannot exercise this at all: its one restaurant points at a place already
  // on the trip, and `suggestion_places` is empty, so zero eat markers are ever built from it.
  const withEatSuggestion = () => ({
    ...TOKYO_TRIP,
    suggestion_places: [
      { id: 'pl_koma', name: 'Koma Sushi', place_type: 'restaurant', lat: 34.6758, lng: 135.6512,
        area: 'Osaka', city: 'Osaka', country_code: 'JP', country_name: 'Japan',
        name_local: null, formatted_address: null, mapbox_id: null } as never,
    ],
    restaurants: [{
      id: 'rest_koma', trip_id: TOKYO_TRIP.trip.id, trip_day_id: 'day_1',
      restaurant_place_id: 'pl_koma', near_place_id: TOKYO_TRIP.places[0].place_id,
      cuisine: 'sushi', summary: 'Counter sushi two minutes from your first stop.',
      source_url: null, evidence_json: { evidence_kind: 'suggested_by_astrail' },
      preference_match_json: {},
    } as never],
  })

  it('puts a findable eat marker on the map for each restaurant suggestion', async () => {
    render(
      <MapProvider>
        <TripMap bundle={withEatSuggestion() as never} activeDayNumber={1} selectedPlaceId={null} onSelectPlace={() => {}} />
      </MapProvider>,
    )
    await flush()
    fireLoad()
    await flush()

    const eat = markerElements.find((e) => e.classList.contains('eat-pin'))
    expect(eat, 'no eat marker was added to the map').toBeDefined()
    // A glyph, not a bare dot: the pin has to say what it IS without being hovered.
    expect(eat!.querySelector('.eat-pin__glyph')).not.toBeNull()
    expect(eat!.querySelector('.eat-pin__label')?.textContent).toContain('Koma')
    expect(eat!.getAttribute('aria-label')).toBe('Koma Sushi, sushi')
  })

  it('shows the eat label by zoom, not by hover — a phone has no hover', async () => {
    mapInstance.getZoom.mockReturnValue(13)          // city zoom: labels on
    render(
      <MapProvider>
        <TripMap bundle={withEatSuggestion() as never} activeDayNumber={1} selectedPlaceId={null} onSelectPlace={() => {}} />
      </MapProvider>,
    )
    await flush()
    fireLoad()
    await flush()

    const label = markerElements
      .find((e) => e.classList.contains('eat-pin'))!
      .querySelector('.eat-pin__label')!
    expect(label.classList.contains('eat-pin__label--visible')).toBe(true)
    // ...and the trail label's own class is NOT borrowed: an unscoped shared modifier would
    // reveal trail labels the zoom gate had just hidden.
    expect(label.classList.contains('constellation-pin__label--visible')).toBe(false)
  })

  it('flies to a restaurant chosen from the sidebar and opens its card', async () => {
    // Selecting from "Where to eat" set `selectedRestaurantPlaceId`, TripMap added
    // `eat-pin--selected`, and that was the entire interaction — so the click highlighted
    // something off-screen and read as doing nothing at all.
    const bundle = withEatSuggestion()
    const view = render(
      <MapProvider>
        <TripMap bundle={bundle as never} activeDayNumber={1} selectedPlaceId={null} onSelectPlace={() => {}} />
      </MapProvider>,
    )
    await flush()
    fireLoad()
    await flush()
    mapInstance.flyTo.mockClear()
    popupElements.length = 0

    view.rerender(
      <MapProvider>
        <TripMap bundle={bundle as never} activeDayNumber={1} selectedPlaceId={null}
          onSelectPlace={() => {}} selectedRestaurantPlaceId="pl_koma" />
      </MapProvider>,
    )
    await flush()

    expect(mapInstance.flyTo).toHaveBeenCalledWith(
      expect.objectContaining({ center: [135.6512, 34.6758] }),
    )
    const card = popupElements.at(-1)!
    expect(card.textContent).toContain('Where to eat')
    expect(card.textContent).toContain('sushi')                       // cuisine
    expect(card.textContent).toContain('Counter sushi')               // why Astrail picked it
  })

  it('shows a hotel hub its class and price, and says the price is not an offer', async () => {
    // Toggled to HOTEL after load, the way the layer switch reaches it — the effect keys on
    // [selectedHotelId, layerMode], so a value present at mount resolves before the map is ready.
    const view = render(
      <MapProvider>
        <TripMap bundle={TOKYO_TRIP_WITH_HOTELS} activeDayNumber={1} selectedPlaceId={null} onSelectPlace={() => {}} />
      </MapProvider>,
    )
    await flush()
    fireLoad()
    await flush()
    popupElements.length = 0

    view.rerender(
      <MapProvider>
        <TripMap bundle={TOKYO_TRIP_WITH_HOTELS} activeDayNumber={1} selectedPlaceId={null}
          onSelectPlace={() => {}} layerMode="hub" selectedHotelId="hotel_1" />
      </MapProvider>,
    )
    await flush()

    const card = popupElements.find((e) => e.textContent?.includes('Where to stay'))
    expect(card, 'the hub opened no popup').toBeDefined()
    expect(card!.textContent).toContain('Shinjuku Granbell Hotel')
    expect(card!.textContent).toContain('4 star')
    expect(card!.textContent).toContain('USD 128 / night')
    expect(card!.textContent).toContain('USD 384 total')
    // Astrail does not book. A bare number reads as a held price, which it is not.
    expect(card!.textContent).toContain('Astrail does not book')
  })

  it('invents neither opening hours nor a photo for a suggestion', async () => {
    // The schema has no hours, price-per-person, phone or image for a restaurant, and Travala
    // returns no image. Guardrail #1: a plausible "Open until 18:00" is the exact failure this
    // product promises not to make, and a popup is where it would look most authoritative.
    const bundle = withEatSuggestion()
    const view = render(
      <MapProvider>
        <TripMap bundle={bundle as never} activeDayNumber={1} selectedPlaceId={null} onSelectPlace={() => {}} />
      </MapProvider>,
    )
    await flush()
    fireLoad()
    await flush()
    popupElements.length = 0
    view.rerender(
      <MapProvider>
        <TripMap bundle={bundle as never} activeDayNumber={1} selectedPlaceId={null}
          onSelectPlace={() => {}} selectedRestaurantPlaceId="pl_koma" />
      </MapProvider>,
    )
    await flush()

    const card = popupElements.at(-1)!
    expect(card.querySelector('img')).toBeNull()
    expect(card.textContent).not.toMatch(/open(s|ing)?\b.*\d|hours|closed/i)
  })

  it('frames its own places instead of inheriting the generation camera', async () => {
    renderMap()
    await flush()
    fireLoad()

    expect(mapInstance.fitBounds).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxZoom: 14, pitch: 45 }),
    )
  })

  // Seamless dashboard -> workspace handoff: the trips dashboard already framed this trip on
  // the shared map, so the workspace settles quickly into its panel geometry rather than
  // re-flying the whole camera.
  it('settles quickly when the dashboard already framed this trip', async () => {
    markTripFramed(TOKYO_TRIP.trip.id)
    renderMap()
    await flush()
    fireLoad()

    expect(mapInstance.fitBounds).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ duration: 900 }),
    )
  })

  it('does a full framing fly on a direct load (no dashboard handoff)', async () => {
    renderMap()
    await flush()
    fireLoad()

    expect(mapInstance.fitBounds).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ duration: 2200 }),
    )
  })

  it('shows a fallback and does not construct a map without a token', async () => {
    delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN
    renderMap()
    await flush()

    expect(screen.getByText(/map unavailable/i)).toBeInTheDocument()
    expect(MapCtor).not.toHaveBeenCalled()
  })

  // Navigating away, not tearing down the shell: the provider stays mounted and the map
  // survives, so layers this trip added would otherwise paint over the next one. (React
  // destroys a parent before its children, so unmounting the whole tree would null the
  // map first and this would pass without proving anything.)
  it('drops its route layers when it unmounts but the shared map lives on', async () => {
    mapInstance.getLayer.mockReturnValue({} as never)
    mapInstance.getSource.mockReturnValue({} as never)
    const view = renderMap()
    await flush()
    fireLoad()
    expect(mapInstance.addLayer).toHaveBeenCalled()

    view.rerender(<MapProvider><div /></MapProvider>)
    expect(mapInstance.removeLayer).toHaveBeenCalledWith('trip-trail-core')
    expect(mapInstance.removeSource).toHaveBeenCalledWith('trip-trail')
    mapInstance.getLayer.mockReturnValue(undefined as never)
    mapInstance.getSource.mockReturnValue(undefined as never)
  })

  /* Rendered WITH hotels because the last assertion is about the base-hotel pin receding, and
     that place travels with the hotels now (a trip made today has neither). Numbering is
     unaffected: the base hotel is undayed, so it was never in the 1..N sequence. */
  it('draws one continuous trail through every stop and numbers them globally', async () => {
    renderMap({ bundle: TOKYO_TRIP_WITH_HOTELS })
    await flush()
    fireLoad()

    // one route source with a brass casing and day-coloured dashed core
    expect(mapInstance.addLayer).toHaveBeenCalledWith(expect.objectContaining({
      id: 'trip-trail-casing',
      paint: expect.objectContaining({ 'line-width': 9, 'line-opacity': 0.18 }),
    }))
    expect(mapInstance.addLayer).toHaveBeenCalledWith(expect.objectContaining({
      id: 'trip-trail-core',
      paint: expect.objectContaining({
        'line-width': 2.6,
        'line-dasharray': [0.1, 1.6],
        'line-color': ['get', 'color'],
      }),
    }))
    // Each day is a separate feature so Mapbox can colour it independently — one per day the
    // trip actually has, read from the fixture rather than listed, so consolidating the trip
    // cannot leave this asserting a day that no longer exists.
    expect(mapInstance.addSource).toHaveBeenCalledWith('trip-trail', expect.objectContaining({
      data: expect.objectContaining({
        type: 'FeatureCollection',
        features: expect.arrayContaining(
          TOKYO_TRIP.days.map((d) => expect.objectContaining({
            properties: expect.objectContaining({ day_number: d.day_number }),
          })),
        ),
      }),
    }))

    // Filter by class, not by position: eat markers are appended after the trail pins, so a
    // trailing slice silently starts grabbing restaurants instead.
    const markers = markerElements.filter((el) => el.classList.contains('constellation-pin'))
    const byLabel = (name: string) => markers.find((el) => el.getAttribute('aria-label') === name)!
    expect(byLabel('Akasaka Station')).toHaveClass('constellation-pin', 'constellation-pin--reel_extracted')
    expect(byLabel('Akasaka Station')).toHaveTextContent('1')
    // a later-day stop is no longer dimmed — it carries its global number and stays lit
    expect(byLabel('SANDO LAB TOKYO')).not.toHaveClass('constellation-pin--receding')
    expect(byLabel('SANDO LAB TOKYO')).toHaveTextContent('3')
    expect(byLabel('Tokyo Disneyland')).toHaveTextContent('5')
    // the undayed base hotel is not a stop on the trail — it recedes, unnumbered
    expect(byLabel('Shinjuku Granbell Hotel')).toHaveClass('constellation-pin--receding')
  })

  it('shows a place-name chip at city zoom and hides it when zoomed out', async () => {
    renderMap()
    await flush()
    fireLoad()
    await flush()

    const marker = markerElements.find(
      (element) => element.getAttribute('aria-label') === 'Akasaka Station',
    )!
    const chip = marker.querySelector<HTMLElement>('.constellation-pin__label')!
    // The stop number must survive whatever the pin looks like: the WebMCP tools address stops
    // by it ("move stop 7"), so it is the shared vocabulary between the agent and the screen.
    // It renders inside the teardrop when there is no photo, and as a badge when there is.
    const shownNumber =
      marker.querySelector('.constellation-pin__drop-number')?.textContent
      ?? marker.querySelector('.constellation-pin__badge')?.textContent
    expect(shownNumber).toBe('1')
    expect(chip).toHaveTextContent('Akasaka Station')
    expect(chip).toHaveClass('constellation-pin__label--visible')

    mapInstance.getZoom.mockReturnValue(8)
    const zoomHandler = mapInstance.on.mock.calls.find((call) => call[0] === 'zoom')?.[1]
    act(() => { (zoomHandler as () => void)() })
    expect(chip).not.toHaveClass('constellation-pin__label--visible')
  })

  it('truncates a long marker chip without losing the full accessible name', async () => {
    const bundle = structuredClone(TOKYO_TRIP)
    const fullName = 'The Extremely Long Museum of Contemporary Astronomical Art'
    bundle.places[0].place.name = fullName
    renderMap({ bundle })
    await flush()
    fireLoad()

    const marker = markerElements.find(
      (element) => element.getAttribute('aria-label') === fullName,
    )!
    const chip = marker.querySelector<HTMLElement>('.constellation-pin__label')!
    expect(chip.textContent).toMatch(/…$/)
    expect(chip.textContent!.length).toBeLessThan(fullName.length)
    expect(chip).toHaveAttribute('title', fullName)
  })

  it('opens evidence in a text-only popup when a marker is clicked', async () => {
    const bundle = structuredClone(TOKYO_TRIP)
    bundle.places[0].evidence_json.quote = '<img src=x onerror="alert(1)"> Visit before sunset.'
    // Attribution now comes from `source_reel_url` (the field backend-types reserves for the
    // Reel), so the override moves with it. A code the trip's inspiration does not carry also
    // keeps the pin's thumbnail out of the way, leaving the quote as the only markup risk here.
    bundle.places[0].evidence_json.source_reel_url = 'https://www.instagram.com/reel/safe-source/'
    bundle.places[0].evidence_json.source_url = null
    const onSelectPlace = vi.fn()

    renderMap({ bundle, onSelectPlace })
    await flush()
    fireLoad()

    const marker = markerElements.find(
      (element) => element.getAttribute('aria-label') === 'Akasaka Station',
    )!
    act(() => { marker.click() })

    expect(onSelectPlace).toHaveBeenCalledWith(bundle.places[0].place_id)
    expect(PopupCtor).toHaveBeenCalledWith(expect.objectContaining({
      className: 'astrail-evidence-popup',
    }))
    const popup = popupElements.at(-1)!
    expect(popup).toHaveTextContent('Stop 1')
    expect(popup).toHaveTextContent('Day 1')
    expect(popup).toHaveTextContent('<img src=x onerror="alert(1)"> Visit before sunset.')
    expect(popup.querySelector('img')).toBeNull()
    expect(popup.querySelector('a')).toHaveAttribute(
      'href', 'https://www.instagram.com/reel/safe-source/',
    )
  })

  it('does not make an attacker-controlled non-http source URL clickable', async () => {
    const bundle = structuredClone(TOKYO_TRIP)
    // BOTH source fields: either one reaching an href unchecked is the same hole.
    bundle.places[0].evidence_json.source_url = 'javascript:alert(document.cookie)'
    bundle.places[0].evidence_json.source_reel_url = 'javascript:alert(document.cookie)'

    renderMap({ bundle })
    await flush()
    fireLoad()
    const marker = markerElements.find(
      (element) => element.getAttribute('aria-label') === 'Akasaka Station',
    )!
    act(() => { marker.click() })

    const popup = popupElements.at(-1)!
    expect(popup).toHaveTextContent('javascript:alert(document.cookie)')
    expect(popup.querySelector('a')).toBeNull()
  })

  it('colours each day segment while keeping the trail continuous', async () => {
    renderMap()
    await flush()
    fireLoad()

    const features = trailFeatures()
    const dayNumbers = TOKYO_TRIP.days.map((d) => d.day_number)
    expect(features.map((feature) => feature.properties.day_number)).toEqual(dayNumbers)
    // One distinct colour per day — that is what "colours each day segment" means.
    expect(new Set(features.map((feature) => feature.properties.color)).size).toBe(dayNumbers.length)
    for (let index = 1; index < features.length; index++) {
      expect(features[index].geometry.coordinates[0]).toEqual(
        features[index - 1].geometry.coordinates.at(-1),
      )
    }
  })

  it('adds 3D buildings from the composite source at street zoom', async () => {
    mapInstance.getSource.mockImplementation((id?: string) =>
      id === 'composite' ? ({} as never) : undefined)
    renderMap()
    await flush()
    fireLoad()

    expect(mapInstance.addLayer).toHaveBeenCalledWith(expect.objectContaining({
      id: 'astrail-3d-buildings',
      type: 'fill-extrusion',
      source: 'composite',
      'source-layer': 'building',
      minzoom: 15,
      slot: 'middle',
    }))
    mapInstance.getSource.mockReturnValue(undefined as never)
  })

  it('skips 3D buildings when the active style has no composite source', async () => {
    renderMap()
    await flush()
    fireLoad()

    expect(mapInstance.addLayer).not.toHaveBeenCalledWith(expect.objectContaining({
      id: 'astrail-3d-buildings',
    }))
  })

  it('keeps one whole-trip trail — switching the active day does not redraw it', async () => {
    const view = renderMap()
    await flush()
    fireLoad()

    mapInstance.addSource.mockClear()
    mapInstance.flyTo.mockClear()
    view.rerender(
      <MapProvider>
        <TripMap bundle={TOKYO_TRIP} activeDayNumber={2} selectedPlaceId={null} onSelectPlace={() => {}} />
      </MapProvider>,
    )
    // day change only moves the camera; the trail is day-independent, so it is not re-added
    expect(mapInstance.addSource).not.toHaveBeenCalledWith('trip-trail', expect.anything())
    expect(mapInstance.flyTo).toHaveBeenCalled() // Day 2's single stop → camera flies there
  })

  // The wiring itself: the source must receive the LEG's road points, not five straight
  // pin-to-pin coordinates. Reverting drawTrail to `stops.map(...)` reddens this.
  it('draws the trail from per-leg route geometry, not straight pin-to-pin links', async () => {
    renderMap()
    await flush()
    fireLoad()

    const coordinates = trailCoords()
    for (const point of [...geomOf('leg_1').slice(1, -1), ...geomOf('leg_2').slice(1, -1)]) {
      expect(coordinates).toContainEqual(point)
    }
    // 5 stops + 4 interior points on each of the two same-day hops
    expect(coordinates).toHaveLength(13)
  })

  // ---- Hotel-hub map (plan 2026-08-04-hotel-hub-map, T9) ----
  // Every case below renders TOKYO_TRIP_WITH_HOTELS, not the demo bundle: hotel search is off, so
  // a trip generated today has no hotel rows and nothing here would have anything to draw. These
  // are the pre-switch trips that do — still in the database, still opened by their owners.
  // Route mode is covered by the trail test above (the receding base-hotel pin at 'the undayed
  // base hotel is not a stop on the trail' MUST stay green — it proves route mode is untouched).
  // The spoke GEOMETRY is unit-tested in T7 (selectors); here we assert at the marker-class /
  // layer-added level, the right altitude for canvas-heavy map rendering.

  it('hub mode pins the selected placed hotel, draws spokes, and suppresses the duplicate base-hotel place pin', async () => {
    renderMap({ bundle: TOKYO_TRIP_WITH_HOTELS, selectedHotelId: 'hotel_1', layerMode: 'hub' })
    await flush()
    fireLoad()

    // exactly one distinct hub pin, at the selected PLACED hotel (hotel_1 → geo_status 'placed')
    const hubPins = markerElements.filter((el) => el.classList.contains('hotel-hub-pin'))
    expect(hubPins).toHaveLength(1)
    expect(hubPins[0]).toHaveAttribute('aria-label', 'Shinjuku Granbell Hotel')

    // the base-hotel PLACE marker is suppressed — no constellation-pin duplicate under the hub
    const baseDuplicate = markerElements.filter(
      (el) => el.classList.contains('constellation-pin')
        && el.getAttribute('aria-label') === 'Shinjuku Granbell Hotel',
    )
    expect(baseDuplicate).toHaveLength(0)

    // spokes layer added; the itinerary trail is gated OFF in hub mode
    expect(mapInstance.addSource).toHaveBeenCalledWith('hotel-spokes', expect.anything())
    expect(mapInstance.addSource).not.toHaveBeenCalledWith('trip-trail', expect.anything())
  })

  // Proves the [selectedHotelId, layerMode] redraw effect is load-bearing: a live toggle must tear
  // the trail down (via routeIdsRef/clearRoutes) and draw the spokes in its place.
  it('toggling route -> hub tears down the itinerary trail and draws the hotel spokes', async () => {
    const view = renderMap({ bundle: TOKYO_TRIP_WITH_HOTELS }) // route mode by default
    await flush()
    fireLoad()
    expect(mapInstance.addSource).toHaveBeenCalledWith('trip-trail', expect.anything())

    // clearRoutes only removes layers/sources the map reports it currently has
    mapInstance.getLayer.mockReturnValue({} as never)
    mapInstance.getSource.mockReturnValue({} as never)
    mapInstance.addSource.mockClear()
    view.rerender(
      <MapProvider>
        <TripMap
          bundle={TOKYO_TRIP_WITH_HOTELS}
          activeDayNumber={1}
          selectedPlaceId={null}
          onSelectPlace={() => {}}
          selectedHotelId="hotel_1"
          layerMode="hub"
        />
      </MapProvider>,
    )

    expect(mapInstance.removeLayer).toHaveBeenCalledWith('trip-trail-core')
    expect(mapInstance.addSource).toHaveBeenCalledWith('hotel-spokes', expect.anything())
    mapInstance.getLayer.mockReturnValue(undefined as never)
    mapInstance.getSource.mockReturnValue(undefined as never)
  })

  it('hub mode with no hotel selected draws no hub and no spokes (honest empty-state)', async () => {
    renderMap({ bundle: TOKYO_TRIP_WITH_HOTELS, selectedHotelId: null, layerMode: 'hub' })
    await flush()
    fireLoad()

    expect(markerElements.filter((el) => el.classList.contains('hotel-hub-pin'))).toHaveLength(0)
    expect(mapInstance.addSource).not.toHaveBeenCalledWith('hotel-spokes', expect.anything())
  })

  it('hub mode with an unresolved (unplaceable) selected hotel draws no hub and no spokes', async () => {
    renderMap({ bundle: TOKYO_TRIP_WITH_HOTELS, selectedHotelId: 'hotel_2', layerMode: 'hub' }) // hotel_2 → geo_status 'unresolved'
    await flush()
    fireLoad()

    expect(markerElements.filter((el) => el.classList.contains('hotel-hub-pin'))).toHaveLength(0)
    expect(mapInstance.addSource).not.toHaveBeenCalledWith('hotel-spokes', expect.anything())
  })
})
