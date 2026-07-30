'use client'

/* FolderGallery — the "reel wallet": a dark travel-folder object that sits on the paper
   home and fans its saved-Reel thumbnails open on tap, closed by dragging a photo down.
   Ported from the interactive-folder-gallery reference and reskinned to the Astrail token
   system (night object on paper, brass thread accent — the only accent, per palette.css).

   Adaptations over the reference:
   - motion/react (framer-motion 12) instead of "framer-motion".
   - Real reel thumbnails via `photos[].image` (nullable → a placeholder tile, never a
     broken <img> and never invented geometry — guardrail #1).
   - Centering generalised to any photo count (offset around the median), not a hard 5.
   - Keyboard-openable (Enter/Space), Escape-closes; the hint pill is a real close button
     so pointer users who can't drag still have a way out. */

import { useEffect, useState } from 'react'
import { motion } from 'motion/react'

export interface FolderPhoto {
  id: string | number
  /** Reel thumbnail URL; null renders a placeholder tile instead of a broken image. */
  image: string | null
  alt?: string
}

export interface FolderGalleryProps {
  photos: FolderPhoto[]
  folderName?: string
  dragHintText?: string
  className?: string
}

export function FolderGallery({
  photos,
  folderName = 'Saved reels',
  dragHintText = 'Drag any photo down to close',
  className,
}: FolderGalleryProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [hover, setHover] = useState(false)

  // Escape closes the open fan — keyboard parity with the drag-down gesture.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setIsOpen(false); setHover(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen])

  if (!photos.length) return null

  const close = () => { setIsOpen(false); setHover(false) }
  // Median-centred offsets so any count fans symmetrically (reference hard-coded 5).
  const center = (photos.length - 1) / 2
  // Fanned-open horizontal spread, clamped so a large stack still fits the stage.
  const spread = Math.min(138, 560 / Math.max(photos.length, 1))

  return (
    <div className={`relative flex items-center justify-center overflow-hidden ${className ?? ''}`}>
      {/* Stage — one fixed coordinate space, scaled down on small screens so the open fan
          never overflows the paper column. */}
      <div className="relative h-[440px] w-[340px] origin-center scale-[0.7] sm:scale-90 md:scale-100">

        {/* Folder back — the pocket the photos live in (closed state only). */}
        <motion.div
          className="absolute bottom-6 left-1/2 h-52 w-72 -translate-x-1/2 drop-shadow-2xl"
          animate={{ opacity: isOpen ? 0 : 1, scale: isOpen ? 0.9 : 1 }}
          transition={{ type: 'spring', stiffness: 350, damping: 30 }}
        >
          <div className="absolute left-0 top-0 h-10 w-32 rounded-t-xl border-l border-r border-t border-[color:var(--night-line)] bg-linear-to-t from-[color:var(--night-800)] to-[color:var(--night-surface)]" />
          <div className="absolute bottom-0 left-0 right-0 top-8 rounded-b-xl rounded-tr-xl border border-[color:var(--night-line)] bg-linear-to-b from-[color:var(--night-800)] to-[color:var(--night-void)] shadow-[inset_0_0_40px_rgba(0,0,0,0.7)]" />
          <div className="pointer-events-none absolute bottom-2 left-2 right-2 top-10 rounded-lg bg-[color:var(--night-void)] shadow-inner" />
        </motion.div>

        {/* Photo stack — the saved-Reel thumbnails. */}
        <div className="absolute bottom-10 left-1/2 z-10 flex -translate-x-1/2 justify-center">
          {photos.map((photo, i) => {
            const offset = i - center

            const closedY = hover ? offset * -8 - 36 : offset * -4
            const closedX = hover ? offset * 26 : offset * 3
            const closedRotate = hover ? offset * 7 : offset * 2
            const closedScale = 1 - Math.abs(offset) * 0.03

            return (
              <motion.div
                key={photo.id}
                drag={isOpen}
                dragSnapToOrigin
                onDragEnd={(_e, info) => {
                  if (isOpen && info.offset.y > 100) close()
                }}
                className={`absolute bottom-0 h-64 w-36 origin-bottom overflow-hidden rounded-xl border border-white/20 shadow-[0_20px_40px_rgba(0,0,0,0.5)] ${
                  isOpen ? 'cursor-grab pointer-events-auto active:cursor-grabbing' : 'pointer-events-none'
                }`}
                animate={
                  isOpen
                    ? { y: -120, x: offset * spread, rotate: 0, scale: 1.02, zIndex: 50 }
                    : { y: closedY, x: closedX, rotate: closedRotate, scale: closedScale, zIndex: i + 10 }
                }
                whileHover={isOpen ? { scale: 1.08, zIndex: 100 } : {}}
                whileDrag={isOpen ? { scale: 1.12, rotate: 5, zIndex: 150 } : {}}
                transition={{ type: 'spring', stiffness: 350, damping: 30 }}
              >
                {photo.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photo.image} alt={photo.alt ?? ''} className="pointer-events-none h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-linear-to-b from-[color:var(--night-surface)] to-[color:var(--night-void)]">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--brass-bright)" strokeWidth="1.5" strokeOpacity="0.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <path d="m21 15-5-5L5 21" />
                    </svg>
                  </div>
                )}
              </motion.div>
            )
          })}
        </div>

        {/* Folder front flap — the tap target that opens the fan (closed state only). */}
        <motion.div
          role="button"
          tabIndex={isOpen ? -1 : 0}
          aria-expanded={isOpen}
          aria-label={`Open ${folderName}`}
          className="absolute bottom-0 left-1/2 z-20 h-40 w-[300px] -translate-x-1/2 cursor-pointer drop-shadow-[0_-20px_40px_rgba(0,0,0,0.55)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[color:var(--brass-bright)]"
          style={{ transformOrigin: 'bottom', pointerEvents: isOpen ? 'none' : 'auto' }}
          animate={{ opacity: isOpen ? 0 : 1, rotateX: hover ? -25 : 0, y: hover ? 10 : 0 }}
          transition={{ type: 'spring', stiffness: 350, damping: 30 }}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          onClick={() => setIsOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsOpen(true) }
          }}
        >
          <div className="relative flex h-full w-full items-end justify-center overflow-hidden rounded-2xl border border-[color:var(--night-line)] bg-linear-to-b from-[color:var(--night-surface)] to-[color:var(--night-void)] pb-7 shadow-[inset_0_2px_10px_rgba(247,243,232,0.08)]">
            <div className="absolute left-0 right-0 top-0 h-px bg-linear-to-r from-transparent via-[color:var(--brass-bright)]/40 to-transparent" />
            <div className="flex items-center justify-center rounded-lg border border-[color:var(--brass-deep)]/40 bg-[color:var(--night-void)] px-5 py-2.5 shadow-inner backdrop-blur-md">
              <span className="text-sm font-medium tracking-wide text-[color:var(--brass-bright)]">{folderName}</span>
            </div>
          </div>
        </motion.div>
      </div>

      {/* Close affordance — visible only when open; also a pointer fallback for the drag. */}
      <motion.button
        type="button"
        onClick={close}
        tabIndex={isOpen ? 0 : -1}
        aria-hidden={!isOpen}
        animate={{ opacity: isOpen ? 1 : 0, y: isOpen ? 0 : 50 }}
        transition={{ type: 'spring', stiffness: 350, damping: 30 }}
        style={{ pointerEvents: isOpen ? 'auto' : 'none' }}
        className="absolute bottom-6 rounded-full border border-[color:var(--line-soft)] bg-[color:var(--surface-2)] px-6 py-3 text-sm font-medium uppercase tracking-widest text-[color:var(--text-muted)] backdrop-blur-md transition-colors hover:text-[color:var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]"
      >
        {dragHintText}
      </motion.button>
    </div>
  )
}

export default FolderGallery
