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
}: {
  bundle: TripBundle | null
  showDay: (day: number) => void
  selectPlace: (placeId: string | null) => void
  setLayerMode: (mode: 'route' | 'hub') => void
  openPanel: () => void
}) {
  const { getMap } = useSharedMap()
  const registry = useOptionalWebMcpRegistry()

  // Publish the open trip so the GLOBAL data tools can use it instead of asking "which trip?".
  // Written to a ref, so this costs no render anywhere.
  const openTripRef = registry?.openTrip
  if (openTripRef) openTripRef.current = bundle
  useEffect(() => () => { if (openTripRef) openTripRef.current = null }, [openTripRef])

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
