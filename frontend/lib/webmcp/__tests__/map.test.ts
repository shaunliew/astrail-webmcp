import { describe, it, expect, vi } from 'vitest'
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
    expect(out).toContain('Shibuya Sky')
  })

  it('flies to a stop by pin number and selects it', () => {
    const d = deps()
    const out = String(showOnMapTool(d).execute({ target: 'place', place: '1' }))
    expect(d.selectPlace).toHaveBeenCalled()
    expect(d.showDay).toHaveBeenCalledWith(1)
    expect(out).toContain('Senso-ji Temple')
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

  it('shows the whole trip and clears any selection', () => {
    const d = deps()
    const out = String(showOnMapTool(d).execute({ target: 'trip' }))
    expect(d.selectPlace).toHaveBeenCalledWith(null)
    expect(d.setLayerMode).toHaveBeenCalledWith('route')
    expect(out).toContain('whole trip')
  })

  it('says plainly when there is no trip open rather than failing silently', () => {
    const out = String(showOnMapTool(deps({ bundle: () => null })).execute({ target: 'trip' }))
    expect(out).toContain('No trip is open')
  })

  it('passes an ambiguous place through instead of flying somewhere wrong', () => {
    const d = deps()
    const out = String(showOnMapTool(d).execute({ target: 'place', place: 'Shibuya' }))
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
})
