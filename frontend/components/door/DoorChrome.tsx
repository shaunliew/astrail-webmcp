'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { Globe } from '@/components/ui/cobe-globe'

/* Shared chrome for the two "door" screens (sign-in, onboarding): a dark map stage,
   the empty wireframe globe, a floating caption, and the paper door card (left rail on
   desktop, bottom card on mobile). DESIGN.md §9 — the door is not a .sheet; it borrows
   the rail geometry but never retracts. */

// Focus ring for door controls — brass-deep, offset. Shared so every control matches.
export const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]'

// Brand lockup — the trail primitive itself: two verified points joined by a line, and
// one unplaced ghost point ahead. The logo IS the product's sentence (DESIGN.md §1).
export function BrandMark() {
  return (
    <svg viewBox="0 0 88 14" aria-hidden className="block h-3.5 w-auto shrink-0">
      <path d="M6 9 L31 5 L56 10" fill="none" stroke="var(--brass-deep)" strokeWidth={1.5} strokeLinecap="round" />
      <circle cx="6" cy="9" r="2.6" fill="var(--brass-deep)" />
      <circle cx="31" cy="5" r="2.6" fill="var(--brass-deep)" />
      <circle cx="56" cy="10" r="2.6" fill="var(--brass-deep)" />
      <circle cx="80" cy="6" r="3" fill="none" stroke="var(--ink-400)" strokeWidth={1.2} strokeDasharray="2 2" />
    </svg>
  )
}

// The brand row: mark + wordmark, sized per type.css .door__word (Fraunces 16, no WONK).
export function DoorBrand() {
  return (
    <div className="mb-8 flex items-center gap-3">
      <BrandMark />
      <span
        className="font-display text-[16px] font-semibold tracking-[0.01em]"
        style={{ fontVariationSettings: "'SOFT' 28, 'WONK' 0, 'opsz' 16" }}
      >
        Astrail
      </span>
    </div>
  )
}

// Pause auto-rotation when the OS asks for reduced motion — the wireframe globe this
// replaced honoured the same preference (via CSS on .globe-grid-drift).
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

// A few well-known cities as inspirational pins — not the user's map (that's still empty,
// per the "Nothing on your map yet" caption), just a hint of what a route can span.
const GLOBE_MARKERS = [
  { id: 'sf', location: [37.7595, -122.4367] as [number, number], label: 'San Francisco' },
  { id: 'nyc', location: [40.7128, -74.006] as [number, number], label: 'New York' },
  { id: 'tokyo', location: [35.6762, 139.6503] as [number, number], label: 'Tokyo' },
  { id: 'london', location: [51.5074, -0.1278] as [number, number], label: 'London' },
  { id: 'sydney', location: [-33.8688, 151.2093] as [number, number], label: 'Sydney' },
  { id: 'capetown', location: [-33.9249, 18.4241] as [number, number], label: 'Cape Town' },
  { id: 'dubai', location: [25.2048, 55.2708] as [number, number], label: 'Dubai' },
  { id: 'paris', location: [48.8566, 2.3522] as [number, number], label: 'Paris' },
  { id: 'saopaulo', location: [-23.5505, -46.6333] as [number, number], label: 'São Paulo' },
]

const GLOBE_ARCS = [
  { id: 'sf-tokyo', from: [37.7595, -122.4367] as [number, number], to: [35.6762, 139.6503] as [number, number] },
  { id: 'nyc-london', from: [40.7128, -74.006] as [number, number], to: [51.5074, -0.1278] as [number, number] },
]

// Spinning cobe globe for the dark door stage: brass pins + arcs on a night-toned sphere.
// Colours are the palette tokens as normalized RGB (cobe wants [0..1], not CSS vars):
//   marker/arc = brass-bright #E8B667 · land dots = a cool night grey · glow = night-blue.
// On desktop it sits to the right, clear of the left-rail card; on mobile it centres above
// the bottom card. The wrapper is pointer-events-auto so only the sphere is draggable.
export function DoorGlobe() {
  const reduced = usePrefersReducedMotion()
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center md:justify-end md:pr-[6vw]"
    >
      <Globe
        className="pointer-events-auto w-[min(66vmin,520px)] max-w-[88vw]"
        markers={GLOBE_MARKERS}
        arcs={GLOBE_ARCS}
        dark={1}
        diffuse={1.2}
        mapBrightness={5}
        baseColor={[0.28, 0.31, 0.4]}
        markerColor={[0.91, 0.71, 0.4]}
        arcColor={[0.91, 0.71, 0.4]}
        glowColor={[0.12, 0.16, 0.3]}
        markerSize={0.03}
        markerElevation={0.012}
        arcWidth={0.5}
        arcHeight={0.28}
        theta={0.25}
        speed={reduced ? 0 : 0.004}
      />
    </div>
  )
}

// The door screen shell. `caption` floats over the globe; `children` fill the paper card.
// Border uses --paper-line-2 (not --line) so the card is correct even inside the /app
// .app-shell scope, which remaps --line to a night value.
export function DoorStage({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="stage relative flex min-h-[100dvh] w-full items-end justify-center overflow-hidden md:items-center md:justify-start">
      <DoorGlobe />
      <p className="pointer-events-none absolute inset-x-0 top-8 z-[1] text-center text-[13px] text-[color:var(--starlight-70)] md:bottom-[12%] md:top-auto">
        {caption}
      </p>
      <main className="relative z-[4] flex max-h-[88dvh] w-full flex-col overflow-y-auto rounded-t-[24px] border border-b-0 border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)] p-6 pb-8 text-[color:var(--text)] shadow-[0_1px_2px_rgba(28,23,16,0.08),0_16px_40px_rgba(28,23,16,0.14)] md:m-6 md:max-w-[420px] md:rounded-[16px] md:border-b md:p-8">
        {children}
      </main>
    </div>
  )
}
