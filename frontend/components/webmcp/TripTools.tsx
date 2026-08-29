'use client'

import { useEffect, useMemo, useRef } from 'react'
import type { TripBundle } from '@/lib/trip/backend-types'
import { useSharedMap } from '@/components/map/MapProvider'
import { tripTools } from '@/lib/webmcp/tools'
import { RegisterTools } from './RegisterTools'
import { useOptionalWebMcpRegistry } from './WebMcpRegistry'

/**
 * The page-scoped half of the tool surface.
 *
 * Only tools that act on the LIVE map belong here — everything that merely reads or mutates trip
 * DATA is registered globally, so the agent can answer "what's on day 2 of my Kyoto trip?" without
 * the user having navigated first. These three genuinely cannot: there is no map to fly on /app.
 *
 * Mounted with key={tripId} by TripWorkspace, so switching trips fully unmounts one set before
 * mounting the next and two same-named registrations never overlap.
 */
export default function TripTools({
  bundle,
  showDay,
  selectPlace,
  setLayerMode,
  openPanel,
  refresh,
  readOnly = false,
}: {
  bundle: TripBundle | null
  showDay: (day: number) => void
  selectPlace: (placeId: string | null) => void
  setLayerMode: (mode: 'route' | 'hub') => void
  openPanel: () => void
  /** Re-reads the trip INTO this page's state, so an agent edit shows without a manual reload. */
  refresh: () => Promise<TripBundle | null>
  /**
   * This trip has no database row behind it — `/app/trip/demo` renders a fixture. The map tools
   * still work (they are pure in-page state), but nothing that WRITES may be pointed at it.
   */
  readOnly?: boolean
}) {
  const { getMap } = useSharedMap()
  const registry = useOptionalWebMcpRegistry()

  // Publish the open trip so the GLOBAL data tools can use it instead of asking "which trip?".
  // Written to a ref, so this costs no render anywhere.
  //
  // WITHHELD for a read-only sample, and this ref is the reason: `resolveBundle`
  // (lib/webmcp/tools/trips.ts) reads it whenever no trip_id is given, and every one of the five
  // edit tools resolves its target through that same call. Publishing a fixture here would point
  // move_place / remove_place / add_place / set_trip_dates / replan_trip at `trip_tokyo_demo`,
  // which is not a row — and four of them raise an approval card BEFORE the write fails, so the
  // user would be asked to authorise a change that cannot happen. Withheld, all five answer
  // "Which trip? Call list_trips and pass its trip_id." and stop there.
  //
  // The read tools (get_itinerary, get_place_evidence) share that one seam, so they answer the
  // same on this route. Serving them the sample while still withholding it from the edit tools
  // has to happen where the two are built — GlobalTools.tsx — not here.
  const openTripRef = readOnly ? undefined : registry?.openTrip
  if (openTripRef) openTripRef.current = bundle
  const refreshRef = readOnly ? undefined : registry?.refreshOpenTrip
  if (refreshRef) refreshRef.current = refresh
  useEffect(() => () => {
    if (openTripRef) openTripRef.current = null
    if (refreshRef) refreshRef.current = null
  }, [openTripRef, refreshRef])

  // Read through refs at call time. `useWebMCP` keeps the execute callback stable by design,
  // so a bundle captured at registration would stay first-render data for the whole session.
  const bundleRef = useRef(bundle)
  bundleRef.current = bundle
  const actionsRef = useRef({ showDay, selectPlace, setLayerMode, openPanel })
  actionsRef.current = { showDay, selectPlace, setLayerMode, openPanel }

  const specs = useMemo(
    () =>
      tripTools({
        bundle: () => bundleRef.current,
        showDay: (d) => actionsRef.current.showDay(d),
        selectPlace: (id) => actionsRef.current.selectPlace(id),
        setLayerMode: (m) => actionsRef.current.setLayerMode(m),
        openPanel: () => actionsRef.current.openPanel(),
        view: () => {
          const map = getMap()
          if (!map) return null
          const c = map.getCenter()
          return { lng: c.lng, lat: c.lat, zoom: map.getZoom() }
        },
      }),
    [getMap],
  )

  // Withheld until the trip has actually loaded: offering "show me day 2" against a null bundle
  // is a trap the agent will walk into and then have to apologise for.
  return <RegisterTools specs={specs} enabled={bundle !== null} />
}
