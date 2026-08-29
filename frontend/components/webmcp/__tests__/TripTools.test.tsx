import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'
import type { TripBundle } from '@/lib/trip/backend-types'
import type { ToolSpec } from '@/lib/webmcp/types'
import { movePlaceTool, type EditDeps } from '@/lib/webmcp/tools/edit'

/**
 * The page-scoped map tools, and the one seam that decides what the GLOBAL tools may touch.
 *
 * `/app/trip/demo` renders a fixture, not a database row. The map tools are pure in-page state,
 * so they work against it unchanged — that is the whole point of the read-only sample. The five
 * edit tools are not: they resolve their target through `TripReader.current()`, which is exactly
 * the ref this component publishes, and they would POST to a trip id that does not exist.
 */

const h = vi.hoisted(() => ({
  specs: [] as ToolSpec[],
  enabled: undefined as boolean | undefined,
  map: null as { getCenter: () => { lng: number; lat: number }; getZoom: () => number } | null,
}))

// The seam that hands us the finished specs, built by the real tripTools() from the real deps.
vi.mock('../RegisterTools', () => ({
  RegisterTools: ({ specs, enabled }: { specs: ToolSpec[]; enabled?: boolean }) => {
    h.specs = specs
    h.enabled = enabled
    return null
  },
}))

// Only `useSharedMap` is reached from this component, and only for `getMap`. Mocking it keeps
// the whole Mapbox bundle — and the shell map's acquire/release lifecycle — out of this file.
vi.mock('@/components/map/MapProvider', () => ({
  useSharedMap: () => ({ getMap: () => h.map }),
}))

const { WebMcpRegistryProvider, useWebMcpRegistry } = await import('../WebMcpRegistry')
const { default: TripTools } = await import('../TripTools')

type Registry = ReturnType<typeof useWebMcpRegistry>

let registry: Registry | null = null
function Probe() {
  registry = useWebMcpRegistry()
  return null
}

const actions = {
  showDay: vi.fn(),
  selectPlace: vi.fn(),
  setLayerMode: vi.fn(),
  openPanel: vi.fn(),
  refresh: vi.fn(async () => TOKYO_TRIP as TripBundle | null),
}

function mount(props: { bundle: TripBundle | null; readOnly?: boolean }) {
  registry = null
  return render(
    <WebMcpRegistryProvider>
      <TripTools {...actions} {...props} />
      <Probe />
    </WebMcpRegistryProvider>,
  )
}

function tool(name: string): ToolSpec {
  const spec = h.specs.find((s) => s.name === name)
  if (!spec) throw new Error(`no ${name} in [${h.specs.map((s) => s.name).join(', ')}]`)
  return spec
}

/** A `move_place` wired to the SAME ref TripTools publishes — the real edit path, mutators stubbed. */
function movePlaceAgainstOpenTrip(mutators: Partial<EditDeps> = {}) {
  return movePlaceTool({
    trips: {
      current: () => (registry!.openTrip.current as TripBundle | null) ?? null,
      list: async () => [],
      load: async () => null,
    },
    add: vi.fn(), setDates: vi.fn(), replan: vi.fn(), remove: vi.fn(),
    move: vi.fn(async () => ({})),
    refresh: async () => TOKYO_TRIP,
    confirm: vi.fn(async () => true),
    ...mutators,
  } as EditDeps)
}

describe('TripTools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.specs = []
    h.enabled = undefined
    h.map = { getCenter: () => ({ lng: 139.7, lat: 35.68 }), getZoom: () => 11.5 }
  })

  it('registers the three map tools once a bundle is present', () => {
    mount({ bundle: TOKYO_TRIP })
    expect(h.specs.map((s) => s.name).sort()).toEqual(['get_map_view', 'set_map_mode', 'show_on_map'])
    expect(h.enabled).toBe(true)
  })

  it('flies the live map to a day of a seeded bundle', async () => {
    mount({ bundle: TOKYO_TRIP, readOnly: true })
    const result = await tool('show_on_map').execute({ target: 'day', day: 2 })
    expect(actions.showDay).toHaveBeenCalledWith(2)
    expect(actions.openPanel).toHaveBeenCalled()
    expect(String(result)).toContain('Shibuya Sky')
  })

  it('switches the map layer on a seeded bundle', async () => {
    mount({ bundle: TOKYO_TRIP, readOnly: true })
    const result = await tool('set_map_mode').execute({ mode: 'hub' })
    expect(actions.setLayerMode).toHaveBeenCalledWith('hub')
    expect(String(result)).toMatch(/hotel/i)
  })

  it('reports the live camera and the seeded trip shape', async () => {
    mount({ bundle: TOKYO_TRIP, readOnly: true })
    const result = String(await tool('get_map_view').execute({}))
    expect(result).toContain('zoom 11.5')
    expect(result).toContain('3 days')
  })

  /**
   * The read-only guard, proved through the REAL edit tool rather than by reading a ref.
   *
   * `resolveBundle` (lib/webmcp/tools/trips.ts) takes the open trip from this ref when no
   * trip_id is passed, and every edit tool in edit.ts goes through it. A sample published here
   * would be POSTed to `/trips/trip_tokyo_demo/...`, which is not a row.
   */
  it('withholds a read-only sample from the open-trip ref, so the edit tools cannot reach it', async () => {
    mount({ bundle: TOKYO_TRIP, readOnly: true })
    expect(registry!.openTrip.current).toBeNull()
    // Nor a refresher: there is no row to re-read for a fixture.
    expect(registry!.refreshOpenTrip.current).toBeNull()

    const move = vi.fn(async () => ({}))
    const confirm = vi.fn(async () => true)
    const result = await movePlaceAgainstOpenTrip({ move, confirm }).execute({ place: '1', to_day: 2 })

    expect(String(result)).toBe('Which trip? Call list_trips and pass its trip_id.')
    expect(move).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
  })

  // Fault injection for the guard above: drop `readOnly` and the very same call goes through,
  // which is what a real trip page must keep doing.
  it('still publishes a real trip, so the edit tools keep working there', async () => {
    mount({ bundle: TOKYO_TRIP })
    expect(registry!.openTrip.current).toBe(TOKYO_TRIP)
    expect(registry!.refreshOpenTrip.current).toBe(actions.refresh)

    const move = vi.fn(async () => ({}))
    await movePlaceAgainstOpenTrip({ move }).execute({ place: '1', to_day: 2 })
    expect(move).toHaveBeenCalledWith(TOKYO_TRIP.trip.id, 'tp_senso', { day_number: 2 })
  })
})
