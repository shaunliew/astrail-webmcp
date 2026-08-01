'use client'

import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import mapboxgl from 'mapbox-gl'
import type { TripBundle } from '@/lib/trip/backend-types'
import { getTrip } from '@/lib/trip/supabase-api'
import { markTripFramed } from '@/lib/trip/map-handoff'
import { useSharedMap } from '@/components/map/MapProvider'

/* Right pane of the /app/trips three-pane. Renders no canvas of its own: it drives the
   shared, fixed Mapbox instance (MapProvider, z-0 behind the whole shell). The paper nav +
   inventory panes (z-10) mask the left of the viewport, so the map shows only through the
   transparent right-hand window.

     · idle    — the whole dawn globe, framed in the window, spinning gently. Speed is
                 deliberately calm (SPIN_DEG_PER_SEC) — an earlier faster spin read as dizzy.
                 Stops the instant the user grabs the globe or selects a trip; skipped under
                 reduced motion.
     · select  — fetch the trip, drop its pins, and fly the camera down into them, framed
                 into the window.
   Stage 3 will carry this same camera seamlessly into the full workspace on "Open trip". */

// A place with missing/zero/out-of-range coords is unresolved (a "saved with gaps" trip has
// these). It must not get a pin, and must NOT extend the frame — one (0,0) drags the camera
// out to span half the globe instead of zooming to the real places.
function hasRealCoords(lng: number, lat: number): boolean {
  return (
    Number.isFinite(lng) && Number.isFinite(lat) &&
    Math.abs(lng) <= 180 && Math.abs(lat) <= 90 &&
    (lng !== 0 || lat !== 0)
  )
}

const FRAME_PAD = 56 // breathing room inside the window when framing
const IDLE_GLOBE_ZOOM = 1.4 // whole globe, comfortably filling the window
const SPIN_DEG_PER_SEC = 3 // calm ambient idle rotation (~2 min/revolution); 5 read as dizzy

export default function TripMapDashboard({
  selectedTripId,
  windowRef,
}: {
  selectedTripId: string | null
  windowRef: RefObject<HTMLElement | null>
}) {
  const { hasToken, ready, getMap, acquire, release, setMarkers } = useSharedMap()
  const bundleCacheRef = useRef<Map<string, TripBundle>>(new Map())
  // Monotonic id so a slow fetch for an earlier selection can't land after a newer one.
  const reqRef = useRef(0)
  const [status, setStatus] = useState<'idle' | 'loading' | 'mapped' | 'no-coords'>('idle')

  // Dawn-lit map. Acquired once; the camera is driven by the effects below.
  useEffect(() => {
    acquire({ interactive: true, lightPreset: 'dawn', zoom: IDLE_GLOBE_ZOOM })
    return () => release()
  }, [acquire, release])

  // Frame into the actual right-hand window (measured), so content lands inside it whatever
  // the pane widths are — no hard-coded offset.
  function framePadding(): mapboxgl.PaddingOptions {
    const el = windowRef.current
    if (!el || typeof window === 'undefined') {
      return { top: FRAME_PAD, right: FRAME_PAD, bottom: FRAME_PAD, left: FRAME_PAD }
    }
    const r = el.getBoundingClientRect()
    return {
      top: Math.max(r.top, 0) + FRAME_PAD,
      bottom: Math.max(window.innerHeight - r.bottom, 0) + FRAME_PAD,
      left: Math.max(r.left, 0) + FRAME_PAD,
      right: Math.max(window.innerWidth - r.right, 0) + FRAME_PAD,
    }
  }

  // Idle → frame the whole globe into the window (instant; also un-zooms if we arrived back
  // from a zoomed-in trip), then spin it gently. The spin halts on the first grab gesture so
  // a browse isn't fought, and is skipped entirely under reduced motion.
  useEffect(() => {
    if (!ready || selectedTripId) return
    const map = getMap()
    if (!map) return
    setStatus('idle')
    map.easeTo({
      center: [map.getCenter().lng, 15],
      zoom: IDLE_GLOBE_ZOOM,
      pitch: 0,
      bearing: 0,
      padding: framePadding(),
      duration: 0,
    })

    const reduced =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    if (reduced) return

    let stopped = false
    let raf = 0
    let last = performance.now()
    const halt = () => { stopped = true }
    map.on('mousedown', halt)
    map.on('touchstart', halt)
    map.on('dragstart', halt)

    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      if (!stopped) {
        const c = map.getCenter()
        map.setCenter([c.lng - SPIN_DEG_PER_SEC * dt, c.lat])
        raf = requestAnimationFrame(tick)
      }
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      map.off('mousedown', halt)
      map.off('touchstart', halt)
      map.off('dragstart', halt)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, selectedTripId])

  // Selection → fetch the bundle, drop pins, and fly the camera into the trip.
  useEffect(() => {
    if (!ready || !selectedTripId) return
    const map = getMap()
    if (!map) return

    const req = ++reqRef.current
    let cancelled = false
    setStatus('loading')

    async function run() {
      let bundle = bundleCacheRef.current.get(selectedTripId!)
      if (!bundle) {
        const fetched = await getTrip(selectedTripId!)
        if (!fetched) { if (req === reqRef.current) setStatus('idle'); return }
        bundle = fetched
        bundleCacheRef.current.set(selectedTripId!, bundle)
      }
      // A newer selection won the race, or we unmounted — drop this result.
      if (cancelled || req !== reqRef.current) return

      const pts = bundle.places
        .filter((tp) => hasRealCoords(tp.place.lng, tp.place.lat))
        .map((tp) => [tp.place.lng, tp.place.lat] as [number, number])

      const markers = pts.map(([lng, lat]) => {
        const el = document.createElement('div')
        el.className = 'constellation-pin constellation-pin--receding'
        return new mapboxgl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map!)
      })
      setMarkers(markers)

      if (pts.length === 0) {
        // Saved-with-gaps / nothing located yet: don't fit to (0,0). Ease to a calm frame.
        setStatus('no-coords')
        map!.easeTo({ zoom: 2.6, pitch: 0, padding: framePadding(), duration: 1600, essential: true })
        return
      }
      setStatus('mapped')
      // We've framed this trip on the shared map — let the workspace settle in seamlessly
      // instead of re-flying if the user opens it.
      markTripFramed(selectedTripId!)
      if (pts.length === 1) {
        map!.flyTo({ center: pts[0], zoom: 12, pitch: 45, padding: framePadding(), duration: 2000, essential: true })
        return
      }
      const bounds = new mapboxgl.LngLatBounds()
      pts.forEach((p) => bounds.extend(p))
      map!.fitBounds(bounds, { padding: framePadding(), maxZoom: 13, pitch: 45, duration: 2200, essential: true })
    }

    void run()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, selectedTripId])

  if (!hasToken) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--text-faint)]">
          Map unavailable — token missing
        </p>
      </div>
    )
  }

  // Small dark status pills float over the (dark) map; the canvas itself is the shell's
  // fixed layer, so there's nothing else to render here.
  if (status === 'loading' || status === 'no-coords') {
    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-5 z-10 flex justify-center">
        <span className="rounded-full bg-[rgba(18,22,31,0.82)] px-3 py-1.5 text-[11px] font-medium text-[color:var(--starlight)] shadow-[0_2px_12px_rgba(0,0,0,0.35)]">
          {status === 'loading' ? 'Loading trip…' : 'No mapped places yet'}
        </span>
      </div>
    )
  }

  return null
}
