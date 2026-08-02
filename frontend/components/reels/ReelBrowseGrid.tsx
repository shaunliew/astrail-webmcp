'use client'

import { useEffect, useState } from 'react'
import type { SavedReelCard } from '@/lib/reels/backend-types'
import { countryLabel, reelLabel, statusLabel } from '@/lib/reels/labels'

/* ReelBrowseGrid — the default "Browse" view of the Library. It replaced the card-fan carousel
   (kept at ui/card-fan-carousel.tsx for reference): the fan showed only bare, cropped thumbnails,
   so you couldn't tell reels apart without opening one. This is a scannable, on-brand grid that
   mirrors the Select-mode tile structure — a 9:16 cover plus the reel's label, grounded
   place-count + country, and status — minus the selection checkbox. Tapping a card opens the
   ReelInfoCard via onOpenReel.

   Motion is native — this repo animates with gsap + CSS, not motion/react, so pulling that runtime
   into the reels route just for a tilt isn't worth the weight. A subtle mouse-driven 3D tilt on
   hover (dialed well down from the source demo's ±25°) and a staggered mount fade, both fully
   disabled under prefers-reduced-motion (matched to the OrganizeGlobe idiom).

   Titles use conciseLabel: most reels have no personal_label, so reelLabel falls back to the full
   caption (hundreds of chars). We show — and expose as the accessible name — only its first
   sentence, capped, so a screen reader never reads an entire caption and the visible title matches
   the accessible name (WCAG 2.5.3). Short labels pass through unchanged. */

const MAX_TILT = 8 // degrees at the card edge
const MAX_LABEL = 80 // chars — accessible-name / visible-title cap for long captions

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** First sentence of a reel's label, capped at a word boundary. Short labels return unchanged. */
function conciseLabel(full: string): string {
  const text = full.replace(/\s+/g, ' ').trim()
  const end = text.search(/[.!?。！？]/)
  let base = end > 0 ? text.slice(0, end) : text
  if (base.length > MAX_LABEL) base = base.slice(0, MAX_LABEL).replace(/\s+\S*$/, '')
  return base || text.slice(0, MAX_LABEL)
}

const PlaceholderGlyph = () => (
  <span
    aria-hidden
    className="absolute inset-0 flex items-center justify-center text-[color:var(--brass-deep)] opacity-40"
  >
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  </span>
)

function ReelCard({
  card,
  index,
  reduced,
  onOpen,
}: {
  card: SavedReelCard
  index: number
  reduced: boolean
  onOpen: (card: SavedReelCard) => void
}) {
  const [tilt, setTilt] = useState({ rx: 0, ry: 0 })
  // Staggered mount reveal: start hidden (unless reduced), then flip on the next frame so the
  // opacity/translate transition on the wrapper actually runs.
  const [shown, setShown] = useState(reduced)
  useEffect(() => {
    if (reduced) return
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [reduced])

  function handleMove(e: React.MouseEvent<HTMLButtonElement>) {
    if (reduced) return
    const rect = e.currentTarget.getBoundingClientRect()
    const px = (e.clientX - rect.left) / rect.width - 0.5 // -0.5..0.5
    const py = (e.clientY - rect.top) / rect.height - 0.5
    setTilt({ rx: -py * MAX_TILT, ry: px * MAX_TILT })
  }

  const label = conciseLabel(reelLabel(card))
  const country = countryLabel(card)
  const active = card.places.length > 0 || card.analysis_status === 'organized'

  return (
    <li style={{ perspective: '1000px' }}>
      {/* Reveal wrapper owns the one-time staggered mount transition, kept off the tilt so the
          hover response stays instant. */}
      <div
        className="transition-[opacity,transform] duration-500 ease-out"
        style={{
          opacity: shown ? 1 : 0,
          transform: shown ? 'translateY(0)' : 'translateY(10px)',
          transitionDelay: reduced ? '0ms' : `${Math.min(index, 12) * 35}ms`,
        }}
      >
        <button
          type="button"
          aria-label={label}
          onClick={() => onOpen(card)}
          onMouseMove={handleMove}
          onMouseLeave={() => setTilt({ rx: 0, ry: 0 })}
          style={{ transform: `rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg)` }}
          className="group block w-full origin-center overflow-hidden rounded-xl border border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)] text-left shadow-[0_2px_10px_rgba(0,0,0,0.05)] transition-[transform,box-shadow] duration-200 ease-out will-change-transform hover:shadow-[0_14px_30px_rgba(0,0,0,0.16)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]"
        >
          <div className="relative aspect-[9/16] w-full bg-[color:var(--surface-2)]">
            {card.thumbnail_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={card.thumbnail_url} alt="" loading="lazy" className="h-full w-full object-cover" />
            ) : (
              <PlaceholderGlyph />
            )}
          </div>

          <div className="flex flex-col gap-1 px-3 py-2.5">
            <span className="truncate font-display text-[14px] font-medium tracking-[-0.01em] text-[color:var(--text)]">
              {label}
            </span>
            <span className="flex items-center gap-1.5 text-[12px] text-[color:var(--text-muted)]">
              <span
                aria-hidden
                className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                  active ? 'bg-[color:var(--brass-deep)]' : 'bg-[color:var(--text-faint)]'
                }`}
              />
              <span className="truncate">
                {statusLabel(card)}
                {country ? ` · ${country}` : ''}
              </span>
            </span>
          </div>
        </button>
      </div>
    </li>
  )
}

export default function ReelBrowseGrid({
  cards,
  onOpenReel,
}: {
  cards: SavedReelCard[]
  onOpenReel: (card: SavedReelCard) => void
}) {
  const reduced = prefersReducedMotion()
  return (
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {cards.map((card, i) => (
        <ReelCard key={card.id} card={card} index={i} reduced={reduced} onOpen={onOpenReel} />
      ))}
    </ul>
  )
}
