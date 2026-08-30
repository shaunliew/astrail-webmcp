import { describe, it, expect, vi } from 'vitest'
import type { TripBundle } from '@/lib/trip/backend-types'
import { TOKYO_TRIP } from '@/lib/trip/fixtures/tokyo-trip'
import { getMapViewTool, setMapModeTool, showOnMapTool, type MapDeps } from '../tools/map'

const deps = (over: Partial<MapDeps> = {}): MapDeps => ({
  bundle: () => TOKYO_TRIP,
  showDay: vi.fn(),
  selectPlace: vi.fn(),
  setLayerMode: vi.fn(),
  openPanel: vi.fn(),
  view: () => ({ lng: 139.7, lat: 35.7, zoom: 12.4 }),
  ...over,
})

/** No hotel ever got a coordinate — the honest-failure state (C5) that makes TripWorkspace
 *  disable the Hotel toggle, and makes the hub layer draw literally nothing. */
const NO_PLACED_HOTEL: TripBundle = { ...TOKYO_TRIP, hotels: [] }

/** Strip one stop's coordinates, the way a "saved with gaps" trip arrives. `hasRealCoords`
 *  then drops it from the pins, the trail and the camera framing — but NOT from `placesForDay`. */
const withoutCoords = (bundle: TripBundle, tripPlaceId: string): TripBundle => ({
  ...bundle,
  places: bundle.places.map((tp) =>
    tp.id === tripPlaceId ? { ...tp, place: { ...tp.place, lat: 0, lng: 0 } } : tp,
  ),
})

const CANARY = 'ZqCanary'

/** Every place and hotel name replaced by a sentinel, so "did this string come from a caption?"
 *  is answered by construction rather than by reading the formatter. */
const canaryNames = (bundle: TripBundle): TripBundle => ({
  ...bundle,
  places: bundle.places.map((tp) => ({ ...tp, place: { ...tp.place, name: `${CANARY}Stop` } })),
  hotels: bundle.hotels.map((h) => ({ ...h, name: `${CANARY}Hotel` })),
})

describe('show_on_map', () => {
  it('drives the SAME setters a click uses, so an agent action looks like a user action', () => {
    const d = deps()
    showOnMapTool(d).execute({ target: 'day', day: 2 })
    expect(d.showDay).toHaveBeenCalledWith(2)
    expect(d.openPanel).toHaveBeenCalled()
  })

  it('names the stops it just put on screen, so the agent can talk about them', () => {
    const out = String(showOnMapTool(deps()).execute({ target: 'day', day: 2 }))
    expect(out).toContain('Showing day 2')
    expect(out).toContain('SANDO LAB TOKYO')
  })

  it('flies to a stop by pin number and selects it', () => {
    const d = deps()
    const out = String(showOnMapTool(d).execute({ target: 'place', place: '1' }))
    expect(d.selectPlace).toHaveBeenCalled()
    expect(d.showDay).toHaveBeenCalledWith(1)
    expect(out).toContain('Akasaka Station')
  })

  it('refuses a day the trip does not have, with the real range', () => {
    const out = String(showOnMapTool(deps()).execute({ target: 'day', day: 99 }))
    expect(out).toContain('no day 99')
  })

  it('asks which day instead of picking one', () => {
    const d = deps()
    const out = String(showOnMapTool(d).execute({ target: 'day' }))
    expect(d.showDay).not.toHaveBeenCalled()
    expect(out).toContain('Which day?')
  })

  it('restores the route trail, clears any selection, and reports the trip it left on screen', () => {
    const d = deps()
    const out = String(showOnMapTool(d).execute({ target: 'trip' }))
    expect(d.selectPlace).toHaveBeenCalledWith(null)
    expect(d.setLayerMode).toHaveBeenCalledWith('route')
    // Was `toContain('whole trip')`, which asserted the overclaim itself — this branch moves no
    // camera. Tightened to the half of that sentence the page does keep: the trip's real shape.
    expect(out).toContain('3 days, 5 stops')
  })

  it('says plainly when there is no trip open rather than failing silently', () => {
    const out = String(showOnMapTool(deps({ bundle: () => null })).execute({ target: 'trip' }))
    expect(out).toContain('No trip is open')
  })

  it('passes an ambiguous place through instead of flying somewhere wrong', () => {
    const d = deps()
    const out = String(showOnMapTool(d).execute({ target: 'place', place: 'Tokyo' }))
    expect(d.selectPlace).not.toHaveBeenCalled()
    expect(out).toContain('ambiguous')
  })

  it('is NOT marked read-only — a camera flying across the globe is very noticeable', () => {
    // readOnlyHint means "safe to call speculatively without the user noticing".
    expect(showOnMapTool(deps()).annotations?.readOnlyHint).toBe(false)
  })
})

describe('set_map_mode', () => {
  it('switches to the hotel hub view', () => {
    const d = deps()
    const out = String(setMapModeTool(d).execute({ mode: 'hub' }))
    expect(d.setLayerMode).toHaveBeenCalledWith('hub')
    expect(out).toContain('hotel')
  })

  it('rejects an unknown mode', () => {
    const d = deps()
    const out = String(setMapModeTool(d).execute({ mode: '3d' }))
    expect(d.setLayerMode).not.toHaveBeenCalled()
    expect(out).toContain('route')
  })
})

describe('get_map_view', () => {
  it('reports what the user is actually looking at, for resolving "this" and "here"', () => {
    const out = String(getMapViewTool(deps()).execute({}))
    expect(out).toContain('35.700')
    expect(out).toContain('zoom 12.4')
  })

  it('degrades honestly when the map is not ready', () => {
    const out = String(getMapViewTool(deps({ view: () => null })).execute({}))
    expect(out).toContain('camera unavailable')
  })

  it('never claims to report a selection the page does not hand it', () => {
    // MapDeps carries `bundle` and `view` only. TripWorkspace.tsx:210 passes showDay and
    // selectPlace as SETTERS (setActiveDayNumber / setSelectedPlaceId) and keeps the state
    // itself, so there is no seam here through which a selection could be read.
    const spec = getMapViewTool(deps())
    expect(spec.description).not.toMatch(/which day and stop are selected/i)
    expect(String(spec.execute({}))).toMatch(/does not expose which day or stop is selected/i)
  })

  it('drops the caption warning it has no output to justify, and keeps its audited hint', () => {
    const spec = getMapViewTool(deps({ bundle: () => canaryNames(TOKYO_TRIP) }))
    // Camera numbers and counts — no name from a caption can reach the agent through this tool.
    expect(String(spec.execute({}))).not.toContain(CANARY)
    expect(spec.description).not.toMatch(/place names come from reel captions/i)
    // …yet the hint stays TRUE: spec-contract.test.ts audits this as a deliberate over-flag
    // ("kept flagged, not narrowed"). Narrowing it here would buy nothing and cost a guardrail.
    expect(spec.annotations?.untrustedContentHint).toBe(true)
  })
})

/**
 * The audit the reviewer asked for: a judge reads these strings in ChatGPT's "Available site
 * tools" list before touching the page, so an overstatement is a defect catchable without
 * running anything. Each test below pins one claim to what the page actually does.
 */
describe('map tools: claims the page actually keeps', () => {
  it('does not sell target:"trip" as a camera move, because nothing flies the camera there', () => {
    // TripMap frames the whole trip from its [ready] first-paint effect and nowhere else. The
    // three setters this branch calls hit effects that all return before flying: [selectedPlaceId]
    // bails on a null id, and [layerMode] bails unless the mode is 'hub'.
    const d = deps()
    const out = String(showOnMapTool(d).execute({ target: 'trip' }))
    expect(d.showDay).not.toHaveBeenCalled()
    expect(out).not.toContain('Showing the whole trip')
    expect(out).toMatch(/camera did not move/i)
  })

  it('says so in the description too, so the agent knows before it calls', () => {
    expect(showOnMapTool(deps()).description).toMatch(/without moving the camera/i)
  })

  it('counts only the stops that reached the map, and names the one that did not', () => {
    // placesForDay does NOT filter coordinates, so the old string counted a stop that has no pin.
    const bundle = withoutCoords(TOKYO_TRIP, 'tp_ichiran')
    const out = String(showOnMapTool(deps({ bundle: () => bundle })).execute({ target: 'day', day: 2 }))
    expect(out).toContain('1 stop on the map: SANDO LAB TOKYO')
    expect(out).toMatch(/no location/i)
    expect(out).toContain('Ichiran Shibuya')
  })

  it('admits when a day had nothing to frame and the camera fell back to the whole trip', () => {
    // TripMap's [activeDayNumber] effect: frame(pts.length ? pts : <all trip points>).
    const bundle = withoutCoords(withoutCoords(TOKYO_TRIP, 'tp_sandolab'), 'tp_ichiran')
    const out = String(showOnMapTool(deps({ bundle: () => bundle })).execute({ target: 'day', day: 2 }))
    expect(out).toMatch(/whole trip/i)
    expect(out).toMatch(/no location/i)
  })

  it('stops promising hub distances the spoke layer never labels', () => {
    // drawSpokes adds two `line` layers and no symbol layer — the spokes carry a duration_s
    // property that nothing ever renders.
    const out = String(showOnMapTool(deps()).execute({ target: 'hotel_hub' }))
    expect(out).not.toMatch(/how far/i)
    expect(out).toMatch(/no distance/i)
  })

  it('warns when no hotel was geocoded, instead of promising a hub that draws nothing', () => {
    const out = String(showOnMapTool(deps({ bundle: () => NO_PLACED_HOTEL })).execute({ target: 'hotel_hub' }))
    expect(out).toMatch(/no hotel/i)
  })

  it('set_map_mode stops calling the unlabelled spokes "distances"', () => {
    const out = String(setMapModeTool(deps()).execute({ mode: 'hub' }))
    expect(out).not.toMatch(/distances/i)
    expect(out).toMatch(/line/i)
  })

  it('set_map_mode says when hub mode has no geocoded hotel to draw from', () => {
    const out = String(setMapModeTool(deps({ bundle: () => NO_PLACED_HOTEL })).execute({ mode: 'hub' }))
    expect(out).toMatch(/no hotel/i)
  })

  // Hotel search is OFF (2026-08-30 — Travala's MCP 401s every unauthenticated call), so
  // TripWorkspace hides the whole Route/Hotel toggle for a trip with no hotels. That removes the
  // only way BACK out of hub mode, which turns "switch first, then report honestly" from a
  // cosmetic wart into a dead end: hub mode with no placed hotel draws nothing, so an agent call
  // would leave the user on a blank map with no control to recover. Both tools now decline the
  // switch instead of making it and apologising.
  it('show_on_map does not switch INTO a hub layer that would draw nothing', () => {
    const d = deps({ bundle: () => NO_PLACED_HOTEL })
    const out = String(showOnMapTool(d).execute({ target: 'hotel_hub' }))
    expect(d.setLayerMode).not.toHaveBeenCalled()
    expect(out).toMatch(/no hotel/i)
  })

  it('set_map_mode does not switch INTO a hub layer that would draw nothing', () => {
    const d = deps({ bundle: () => NO_PLACED_HOTEL })
    const out = String(setMapModeTool(d).execute({ mode: 'hub' }))
    expect(d.setLayerMode).not.toHaveBeenCalled()
    expect(out).toMatch(/no hotel/i)
  })

  // The other half of the pair: a trip that DOES have a placed hotel still switches, so the two
  // tests above pin the emptiness check rather than a tool that stopped switching altogether.
  it('still switches for a trip whose hotel is on the map', () => {
    const d = deps()
    showOnMapTool(d).execute({ target: 'hotel_hub' })
    expect(d.setLayerMode).toHaveBeenCalledWith('hub')
    const d2 = deps()
    setMapModeTool(d2).execute({ mode: 'hub' })
    expect(d2.setLayerMode).toHaveBeenCalledWith('hub')
  })

  it('set_map_mode still emits no caption-derived name — its audited hint is false', () => {
    // Reading the bundle to tell the truth about the hub must not start echoing the hotel's
    // NAME: spec-contract.test.ts audits this tool as untrustedContentHint:false.
    const spec = setMapModeTool(deps({ bundle: () => canaryNames(TOKYO_TRIP) }))
    expect(spec.annotations?.untrustedContentHint).toBe(false)
    for (const mode of ['route', 'hub', '3d']) {
      expect(String(spec.execute({ mode }))).not.toContain(CANARY)
    }
  })

  it('keeps the claims that are true: route mode really does restore the trail', () => {
    // Verified accurate against drawRouteLayer -> drawTrail, so it is left exactly as it was.
    const out = String(setMapModeTool(deps()).execute({ mode: 'route' }))
    expect(out).toBe('Map is following the trip route again.')
  })

  it('keeps the claims that are true: a resolved stop always has coordinates to fly to', () => {
    // resolvePlaceRef matches over orderedTripPlaces, which already excludes coordinate-less
    // stops — so "Flying to… The pin is highlighted." cannot be reached by a stop with no pin.
    const bundle = withoutCoords(TOKYO_TRIP, 'tp_ichiran')
    const out = String(showOnMapTool(deps({ bundle: () => bundle })).execute({ target: 'place', place: 'Ichiran' }))
    expect(out).not.toMatch(/flying to/i)
    expect(out).toMatch(/no stop matches/i)
  })
})
