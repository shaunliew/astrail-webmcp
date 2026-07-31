'use client'

import type { ReelCollection } from '@/lib/reels/backend-types'

/* TrayCard — one inspiration Tray in the "Your trays" grid, drawn as a paper
   folder: the tray's reel cover peeks out of a kraft-paper pocket, with the tray
   name + reel count on the folder body (the "yaay-clean" presentation).

   Reskinned from the old dark "night" FolderGallery. The palette (palette.css)
   reserves NIGHT for the map — "the map is the only dark surface" — so a dark
   folder inside the paper trays panel read as a foreign navy blob. The folder now
   lives in the paper palette (surface-1 pocket on the paper-1 grid, brass thread
   as the single accent) and belongs on the grid.

   - The tray NAME is the accessible Open control (a <button> → onOpen). The cover
     and count are decorative; there is exactly one interactive control per card.
   - A null thumbnail renders a LIGHT paper placeholder tile, never the dark night
     one and never a broken <img> or invented geometry (guardrail #1).
   - An EMPTY tray (zero reels) still renders: the pocket shows the placeholder,
     name-as-Open-control, and a "0 reels" count, so it stays openable/renamable. */

export interface TrayCover {
  id: string | number
  /** Reel thumbnail URL; null renders a light placeholder tile, never a broken img. */
  image: string | null
  alt?: string
}

const ImageIcon = ({ size = 15, opacity = 1 }: { size?: number; opacity?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeOpacity={opacity} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="m21 15-5-5L5 21" />
  </svg>
)

export default function TrayCard({
  collection,
  reelCount,
  photos,
  onOpen,
}: {
  collection: ReelCollection
  reelCount: number
  photos: TrayCover[]
  onOpen: (collection: ReelCollection) => void
}) {
  const cover = photos.find((p) => p.image) ?? null

  return (
    <article className="relative h-[264px]">
      {/* Depth — a second reel edge peeking behind, only when the tray holds >1.
          A shifted clone of the cover (up + right, slight rotate) so it peeks the
          same at any card width instead of sprawling on narrow 2-col tiles. */}
      {reelCount > 1 ? (
        <div
          aria-hidden
          className="absolute inset-x-4 top-0 h-[160px] -translate-y-[7px] translate-x-[11px] rotate-[3deg] rounded-xl border border-[color:var(--paper-line)] bg-[color:var(--surface-2)] shadow-[0_4px_12px_rgba(28,23,16,0.08)]"
        />
      ) : null}

      {/* Cover peeking out of the top pocket. */}
      <div className="absolute inset-x-4 top-0 h-[160px] overflow-hidden rounded-xl border border-[color:var(--paper-line-2)] bg-[color:var(--surface-2)] shadow-[0_6px_16px_rgba(28,23,16,0.12)]">
        {cover?.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover.image} alt={cover.alt ?? ''} className="h-full w-full object-cover object-top" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[color:var(--brass-deep)]">
            <ImageIcon size={28} opacity={0.4} />
          </div>
        )}
      </div>

      {/* Folder front — the pocket. Name (Open control) + count sit on the body. */}
      <div className="absolute inset-x-0 bottom-0 z-10 flex h-[176px] flex-col justify-end gap-1.5 rounded-2xl border border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)] p-4 shadow-[0_2px_10px_rgba(28,23,16,0.12)]">
        {/* Brass thread on the lip — the single accent (palette: brass deep in paper). */}
        <div aria-hidden className="absolute inset-x-5 top-0 h-px bg-[color:var(--brass-deep)] opacity-40" />
        <button
          type="button"
          onClick={() => onOpen(collection)}
          className="block w-full truncate text-left font-display text-[17px] font-medium leading-tight text-[color:var(--text)] underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]"
        >
          {collection.name}
        </button>
        <span className="flex items-center gap-1.5 text-[13px] text-[color:var(--text-muted)]">
          <ImageIcon />
          {reelCount}
          <span className="sr-only"> {reelCount === 1 ? 'reel' : 'reels'}</span>
        </span>
      </div>
    </article>
  )
}
