import type { ReactNode } from 'react'

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

// Empty wireframe globe — no markers, because nothing is located yet (DESIGN.md §9).
// Drawn on the dark stage; the grid drifts slowly (reduced-motion-safe via CSS).
export function EmptyGlobe() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center">
      <svg viewBox="0 0 200 200" className="h-auto w-[min(62vmin,460px)] overflow-visible">
        <circle cx="100" cy="100" r="86" fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth={1.5} />
        <g className="globe-grid-drift" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={1}>
          <ellipse cx="100" cy="100" rx="86" ry="30" />
          <ellipse cx="100" cy="100" rx="86" ry="58" />
          <ellipse cx="100" cy="100" rx="30" ry="86" />
          <ellipse cx="100" cy="100" rx="58" ry="86" />
          <line x1="14" y1="100" x2="186" y2="100" />
          <line x1="100" y1="14" x2="100" y2="186" />
        </g>
      </svg>
    </div>
  )
}

// The door screen shell. `caption` floats over the globe; `children` fill the paper card.
// Border uses --paper-line-2 (not --line) so the card is correct even inside the /app
// .app-shell scope, which remaps --line to a night value.
export function DoorStage({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="stage relative flex min-h-[100dvh] w-full items-end justify-center overflow-hidden md:items-center md:justify-start">
      <EmptyGlobe />
      <p className="pointer-events-none absolute inset-x-0 top-8 z-[1] text-center text-[13px] text-[color:var(--starlight-70)] md:bottom-[12%] md:top-auto">
        {caption}
      </p>
      <main className="relative z-[4] flex max-h-[88dvh] w-full flex-col overflow-y-auto rounded-t-[24px] border border-b-0 border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)] p-6 pb-8 text-[color:var(--text)] shadow-[0_1px_2px_rgba(28,23,16,0.08),0_16px_40px_rgba(28,23,16,0.14)] md:m-6 md:max-w-[420px] md:rounded-[16px] md:border-b md:p-8">
        {children}
      </main>
    </div>
  )
}
