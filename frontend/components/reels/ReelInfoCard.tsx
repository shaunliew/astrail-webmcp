'use client'

import { useEffect, useRef, useState } from 'react'
import type { ReelCollection, SavedReelCard } from '@/lib/reels/backend-types'
import { STATUS_LABELS, reelLabel, statusLabel } from '@/lib/reels/labels'

/* ReelInfoCard — a centered modal opened from the Library browse grid showing a saved reel's
   cover, its grounded places (name · country · evidence quote, read-only), a single header
   "View Reel" link, and an add-to-tray list.

   Standalone in T2.1a (wired into TraysScreen in T2.1b). Reuses CreateTrayDialog's overlay
   idiom (fixed backdrop + target-check close + role="dialog"), but — because it floats over the
   *interactive* Library — adds the isolation CreateTrayDialog omits: a document-level Escape
   (focus may be anywhere), and focus-restore-to-opener on close/unmount (finding C2).

   Add-to-tray is add-only and optimistic (finding C1): a successful add is recorded locally so
   the row reflects it regardless of the parent's best-effort refresh(). Adds are serialized by a
   single global lock (finding C3): while any add is in flight EVERY tray row and the New-tray row
   are disabled, blocking double-clicks and concurrent cross-row adds. onAddToTray rejects only if
   the write failed → inline error, not marked Added.

   The status/reel-label idioms are shared via lib/reels/labels (extracted once ReelBrowseGrid
   became the third caller). */

const ImageIcon = ({ size = 15, opacity = 1 }: { size?: number; opacity?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeOpacity={opacity} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="m21 15-5-5L5 21" />
  </svg>
)

const TRAY_ROW =
  'flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border border-[color:var(--paper-line-2)] bg-transparent px-4 text-left text-[13px] font-medium text-[color:var(--text)] transition-colors hover:bg-[color:var(--surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)] disabled:cursor-default disabled:opacity-60'

export default function ReelInfoCard({
  card,
  collections,
  traysState,
  traysWithReel,
  onAddToTray,
  onRequestNewTray,
  onClose,
}: {
  card: SavedReelCard
  collections: ReelCollection[]
  traysState: 'loading' | 'error' | 'ready'
  traysWithReel: Set<string>
  onAddToTray: (collectionId: string) => Promise<void>
  onRequestNewTray: () => void
  onClose: () => void
}) {
  const [locallyAdded, setLocallyAdded] = useState<Set<string>>(new Set())
  const [addingId, setAddingId] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  // C1 (error-path): once the tray list has rendered `ready`, latch it — a later best-effort
  // refresh() that flips traysState to loading/error must NOT replace the list (that would hide
  // the optimistic "Added ✓"). Later loading/error then shows as a non-blocking inline notice.
  const hasBeenReadyRef = useRef(false)

  const activeRef = useRef(true)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<Element | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    activeRef.current = true
    openerRef.current = document.activeElement // capture the opener BEFORE moving focus
    closeButtonRef.current?.focus()
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCloseRef.current()
    }
    document.addEventListener('keydown', onKeyDown) // document-level: focus may be anywhere
    return () => {
      activeRef.current = false
      document.removeEventListener('keydown', onKeyDown)
      const opener = openerRef.current
      if (opener instanceof HTMLElement) opener.focus() // restore focus on close/unmount
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (traysState === 'ready') hasBeenReadyRef.current = true
  }, [traysState])

  async function handleAdd(id: string) {
    setAddingId(id)
    setAddError(null)
    try {
      await onAddToTray(id) // rejects ONLY if the write failed
      if (!activeRef.current) return
      setLocallyAdded((prev) => new Set(prev).add(id)) // optimistic: survives a swallowed refresh()
    } catch (err) {
      if (!activeRef.current) return
      setAddError(err instanceof Error ? err.message : 'Could not add to that tray.')
    } finally {
      if (activeRef.current) setAddingId(null)
    }
  }

  // C1: keep showing the list once it has been ready, so a later refresh flip can't hide adds.
  const listReady = traysState === 'ready' || hasBeenReadyRef.current

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(28,23,16,0.45)] p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="reel-info-heading"
        className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)] shadow-[var(--shadow-paper)]"
      >
        <button
          ref={closeButtonRef}
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)] text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]"
        >
          <span aria-hidden>✕</span>
        </button>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {/* Cover */}
          <div className="relative h-[280px] w-full shrink-0 bg-[color:var(--surface-2)]">
            {card.thumbnail_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={card.thumbnail_url} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-[color:var(--brass-deep)]">
                <ImageIcon size={40} opacity={0.4} />
              </div>
            )}
          </div>

          {/* Heading */}
          <div className="px-6 pt-5">
            <h2 id="reel-info-heading" className="line-clamp-2 font-display text-[20px] font-medium tracking-[-0.01em] text-[color:var(--text)]">
              {reelLabel(card)}
            </h2>
            <div className="mt-1 flex items-center justify-between gap-3">
              <span className="text-[13px] text-[color:var(--text-muted)]">{statusLabel(card)}</span>
              <a
                href={card.normalized_url}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-[12px] font-semibold uppercase tracking-wide text-[color:var(--brass-deep)] underline underline-offset-2"
              >
                View Reel
              </a>
            </div>
          </div>

          {/* Places */}
          <div className="px-6 pt-5">
            {card.places.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {card.places.map((place) => (
                  <li key={place.place_id} className="rounded-lg border border-[color:var(--line-soft)] p-3">
                    <span className="flex items-center gap-2 text-[15px] font-medium text-[color:var(--text)]">
                      <span data-testid="place-pin" aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full bg-[color:var(--brass-deep)]" />
                      {place.name}
                    </span>
                    <span className="mt-0.5 block text-[12px] text-[color:var(--text-faint)]">{place.country_name}</span>
                    <span className="mt-1.5 block text-[13px] text-[color:var(--text-muted)]">“{place.evidence_quote}”</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-lg border border-dashed border-[color:var(--line-soft)] p-3 text-[13px] text-[color:var(--text-muted)]">
                {`No places found yet — ${STATUS_LABELS[card.analysis_status]}.`}
              </p>
            )}
          </div>

          {/* Add to a tray */}
          <div className="px-6 pb-6 pt-5">
            <h3 className="mb-3 text-[13px] font-medium text-[color:var(--text)]">Add to a tray</h3>

            {addError ? (
              <p role="alert" className="mb-3 rounded-lg border border-dashed border-[color:var(--line-soft)] bg-[color:var(--surface-2)] p-3 text-[13px] text-[color:var(--text-muted)]">
                {addError}
              </p>
            ) : null}

            {!listReady && traysState === 'loading' ? (
              <p className="text-[13px] text-[color:var(--text-muted)]">Loading your trays…</p>
            ) : (
              <>
                {listReady && traysState !== 'ready' ? (
                  <p role="status" className="mb-2 text-[13px] text-[color:var(--text-muted)]">
                    {traysState === 'loading'
                      ? 'Refreshing your trays…'
                      : "Couldn't refresh your trays — showing your last version."}
                  </p>
                ) : null}
                <ul className="flex flex-col gap-2">
                  {!listReady && traysState === 'error' ? (
                    <li className="rounded-lg border border-dashed border-[color:var(--line-soft)] p-3 text-[13px] text-[color:var(--text-muted)]">
                      {"Couldn't load your trays."}
                    </li>
                  ) : (
                    collections.map((c) => {
                      const added = traysWithReel.has(c.id) || locallyAdded.has(c.id)
                      const isAdding = addingId === c.id
                      return (
                        <li key={c.id}>
                          <button
                            type="button"
                            disabled={added || addingId !== null}
                            onClick={() => void handleAdd(c.id)}
                            className={TRAY_ROW}
                          >
                            <span className="truncate">{c.name}</span>
                            <span className="shrink-0 text-[color:var(--brass-deep)]">
                              {added ? 'Added ✓' : isAdding ? 'Adding…' : 'Add'}
                            </span>
                          </button>
                        </li>
                      )
                    })
                  )}
                  <li>
                    <button
                      type="button"
                      disabled={addingId !== null}
                      onClick={onRequestNewTray}
                      className={`${TRAY_ROW} border-dashed text-[color:var(--brass-deep)]`}
                    >
                      + New tray…
                    </button>
                  </li>
                </ul>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
