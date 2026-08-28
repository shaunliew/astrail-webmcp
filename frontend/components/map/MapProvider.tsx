'use client'

// One Mapbox instance for the whole /app shell.
//
// Why it lives here and not in a route: the night->dawn relight (docs/DESIGN-DRAFT.md
// §6.3) is a transition on a *live* map, and the generation -> trip handoff is a
// router.push across a route boundary. Two instances meant the night map was destroyed
// before the dawn map existed, so there was nothing to animate. This layout is the only
// common ancestor of both sides, so the instance lives here and routes drive it.
//
// Nothing is built until a route asks for a map, and the Mapbox bundle itself is
// imported lazily: this module is reachable from every /app route, and a static import
// put 1.7MB of Mapbox into the shared layout chunk that /app/trips and /app/settings
// would then have to download for a map they never show.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react'
import type mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'

// Read per call rather than at module scope. Next.js inlines NEXT_PUBLIC_* textually
// wherever it appears, so this is identical in a build — but it lets tests vary the
// token without reloading the module, which would hand this file a second React copy.
function mapboxToken(): string | undefined {
  return process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN
}

/** Mapbox's style-spec default. Re-applied so a timed relight cannot linger. */
const DEFAULT_TRANSITION_MS = 300

export type LightPreset = 'night' | 'dawn'

export type AcquireOptions = {
  interactive: boolean
  lightPreset: LightPreset
  /** Applied at construction only — an already-live map keeps its camera. */
  center?: [number, number]
  zoom?: number
}

export type SharedMapContextValue = {
  hasToken: boolean
  /** True once the style has loaded. A persistent map fires 'load' once, ever. */
  ready: boolean
  getMap: () => mapboxgl.Map | null
  /** Declares this route wants the map. Construction may complete asynchronously. */
  acquire: (options: AcquireOptions) => void
  release: () => void
  /** Replaces the marker set wholesale — the caller never has to track removals. */
  setMarkers: (markers: mapboxgl.Marker[]) => void
  setLightPreset: (preset: LightPreset, durationMs?: number) => void
}

const SharedMapContext = createContext<SharedMapContextValue | null>(null)

export function useSharedMap(): SharedMapContextValue {
  const ctx = useContext(SharedMapContext)
  if (!ctx) throw new Error('useSharedMap must be used inside <MapProvider>')
  return ctx
}

/** Null outside the provider, for a consumer whose map work is a bonus rather than its job —
 *  the generation controller relights the globe at dawn, but must still own the run without one. */
export function useOptionalSharedMap(): SharedMapContextValue | null {
  return useContext(SharedMapContext)
}

// interactive:false is a constructor-only option, and this instance outlives both
// phases — so the map is always built inert and gestures are toggled per consumer.
function applyInteractive(map: mapboxgl.Map, on: boolean) {
  if (on) {
    // Anchored to centre so pins do not slide out from under the cursor.
    map.scrollZoom.enable({ around: 'center' })
    map.boxZoom.enable()
    map.dragRotate.enable()
    map.dragPan.enable()
    map.keyboard.enable()
    map.doubleClickZoom.enable()
    map.touchZoomRotate.enable()
    map.touchPitch.enable()
    return
  }
  map.scrollZoom.disable()
  map.boxZoom.disable()
  map.dragRotate.disable()
  map.dragPan.disable()
  map.keyboard.disable()
  map.doubleClickZoom.disable()
  map.touchZoomRotate.disable()
  map.touchPitch.disable()
}

export default function MapProvider({ children }: { children: React.ReactNode }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const markersRef = useRef<mapboxgl.Marker[]>([])
  const desiredPresetRef = useRef<LightPreset | null>(null)
  const appliedPresetRef = useRef<LightPreset | null>(null)
  const transitionMsRef = useRef<number | null>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** What the currently-mounted consumer asked for, or null once it has released. */
  const activeRef = useRef<AcquireOptions | null>(null)
  const loadingRef = useRef(false)

  const [ready, setReady] = useState(false)
  const [visible, setVisible] = useState(false)
  const [interactive, setInteractive] = useState(false)

  // Applied on load as well as on demand: setConfigProperty before the style parses is
  // dropped, and a route can acquire the map long before it is ready.
  const applyPreset = useCallback(() => {
    const map = mapRef.current
    const desired = desiredPresetRef.current
    if (!map || !desired || appliedPresetRef.current === desired) return
    // The style must be parsed before setTransition/setConfigProperty. Called too early
    // (acquire fires applyPreset right after `new Map()`, before the 'load' event), Mapbox's
    // setTransition throws "reading 'transition' of undefined". Bail — the map's own 'load'
    // handler re-runs applyPreset, and transitionMsRef is preserved so the relight still lands.
    if (typeof map.isStyleLoaded === 'function' && !map.isStyleLoaded()) return
    const duration = transitionMsRef.current ?? DEFAULT_TRANSITION_MS
    transitionMsRef.current = null
    map.style?.setTransition({ duration, delay: 0 })
    map.setConfigProperty('basemap', 'lightPreset', desired)
    appliedPresetRef.current = desired
  }, [])

  const setLightPreset = useCallback((preset: LightPreset, durationMs?: number) => {
    if (desiredPresetRef.current === preset) return
    desiredPresetRef.current = preset
    if (durationMs !== undefined) transitionMsRef.current = durationMs
    applyPreset()
  }, [applyPreset])

  const setMarkers = useCallback((markers: mapboxgl.Marker[]) => {
    for (const marker of markersRef.current) marker.remove()
    markersRef.current = markers
  }, [])

  const acquire = useCallback((options: AcquireOptions) => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
    const token = mapboxToken()
    if (!token) return

    activeRef.current = options
    setInteractive(options.interactive)
    setVisible(true)
    // Recorded synchronously, and never re-applied once construction resolves: a
    // relight requested while the Mapbox bundle is still in flight must win, or the
    // map would settle on the preset of the phase the user has already left.
    desiredPresetRef.current = options.lightPreset

    const existing = mapRef.current
    if (existing) {
      applyPreset()
      applyInteractive(existing, options.interactive)
      return
    }
    if (loadingRef.current) return
    loadingRef.current = true

    void import('mapbox-gl').then(({ default: mapboxgl }) => {
      loadingRef.current = false
      const container = containerRef.current
      const wanted = activeRef.current
      // Released while the bundle was in flight — do not build a map nobody is showing.
      if (!container || !wanted || mapRef.current) return
      mapboxgl.accessToken = token
      const map = new mapboxgl.Map({
        container,
        style: 'mapbox://styles/mapbox/standard',
        projection: 'globe',
        center: wanted.center ?? [100, 15],
        zoom: wanted.zoom ?? 1.2,
        pitch: 0,
        interactive: false,
      })
      map.on('load', () => {
        setReady(true)
        applyPreset()
      })
      mapRef.current = map
      if (process.env.NODE_ENV !== 'production') {
        // Dev-only handle so capture/QA sessions can tune Standard config properties.
        ;(window as unknown as { __astrailMaps?: (typeof map)[] }).__astrailMaps ??= []
        ;(window as unknown as { __astrailMaps: (typeof map)[] }).__astrailMaps.push(map)
      }
      applyPreset()
      applyInteractive(map, wanted.interactive)
    })
  }, [applyPreset])

  // Deliberately does NOT reset the light preset: the relight is fired on the outgoing
  // route and has to survive this teardown to still be running when the next one mounts.
  const release = useCallback(() => {
    activeRef.current = null
    setMarkers([])
    mapRef.current?.stop()
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    // Deferred so an immediate re-acquire (the generation -> trip handoff, which
    // unmounts one consumer and mounts the next) never flashes the map away.
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null
      setVisible(false)
      setInteractive(false)
    }, 0)
  }, [setMarkers])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    // trackResize only fires on window resize; a container that changes size for any
    // other reason (device rotation, mobile chrome collapsing) leaves the canvas stale.
    const observer = new ResizeObserver(() => { mapRef.current?.resize() })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // Only on leaving the /app shell entirely — never across an in-shell navigation.
  useEffect(() => () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    mapRef.current?.remove()
    mapRef.current = null
    markersRef.current = []
  }, [])

  const value = useMemo<SharedMapContextValue>(() => ({
    hasToken: Boolean(mapboxToken()),
    ready,
    getMap: () => mapRef.current,
    acquire,
    release,
    setMarkers,
    setLightPreset,
  }), [ready, acquire, release, setMarkers, setLightPreset])

  return (
    <>
      <div
        ref={containerRef}
        data-testid="shared-map"
        aria-hidden
        className={[
          'shared-map',
          visible && ready ? 'shared-map--visible' : '',
          interactive ? 'shared-map--interactive' : '',
        ].filter(Boolean).join(' ')}
      />
      <SharedMapContext.Provider value={value}>{children}</SharedMapContext.Provider>
    </>
  )
}
