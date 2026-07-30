'use client'

import FolderGallery, { type FolderPhoto } from '@/components/ui/folder-gallery'
import type { ReelCollection } from '@/lib/reels/backend-types'

/* TrayCard — one inspiration Tray in the "Your trays" grid. Owns the tray chrome
   (name + reel count + a distinct, accessible Open control) so FolderGallery below
   it stays a purely visual cover. Per plan finding B4:
   - Never wrap FolderGallery in a button (nested interactive controls / a11y). The
     folder's own click just fans the photos; the title-as-link is the Open control.
   - An EMPTY tray still renders here: FolderGallery returns null on zero photos, so
     TrayCard draws its own empty-folder cover + name + count(0) + Open control, so an
     empty tray stays openable / renamable / deletable. */

export default function TrayCard({
  collection,
  reelCount,
  photos,
  onOpen,
}: {
  collection: ReelCollection
  reelCount: number
  photos: FolderPhoto[]
  onOpen: (collection: ReelCollection) => void
}) {
  return (
    <article className="flex flex-col rounded-2xl border border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)] p-3">
      <div className="mb-3 flex min-h-[200px] items-center justify-center overflow-hidden rounded-xl bg-[color:var(--surface-2)]">
        {photos.length ? (
          <FolderGallery photos={photos} folderName={collection.name} className="w-full" />
        ) : (
          <div className="flex flex-col items-center gap-2 py-14 text-center">
            <span aria-hidden className="flex h-14 w-14 items-center justify-center rounded-xl border border-dashed border-[color:var(--paper-line-2)]">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--brass-deep)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
              </svg>
            </span>
            <span className="text-[12px] text-[color:var(--text-faint)]">No reels yet</span>
          </div>
        )}
      </div>
      <div className="flex items-baseline justify-between gap-3 px-1">
        {/* Title-as-link is the accessible Open control (B4) — distinct from FolderGallery's
            own fan-open button, whose accessible name is "Open <name>". */}
        <button
          type="button"
          onClick={() => onOpen(collection)}
          className="truncate text-left font-display text-[16px] font-medium text-[color:var(--text)] underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]"
        >
          {collection.name}
        </button>
        <span className="flex-none text-[13px] text-[color:var(--text-muted)]">
          {reelCount} {reelCount === 1 ? 'reel' : 'reels'}
        </span>
      </div>
    </article>
  )
}
