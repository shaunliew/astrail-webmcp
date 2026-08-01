'use client'

import { useEffect, useRef, useState } from 'react'
import type { ReelCollection, SavedReelCard } from '@/lib/reels/backend-types'

/* TrayDetail — the full-surface view reached by Opening a tray from the "Your trays" grid
   (TraysScreen keys it by openTrayId and derives the collection from state, so a rename
   re-renders the shown name — Decision 4). It lists the tray's member reels and owns tray
   management: inline Rename, Delete (confirm), and per-reel Remove, plus a Create trail
   action that hands the tray's grounded places to the parent's generate seam.

   ONE mutation-wide lock (finding, Decision 5): a single `mutating` flag disables rename
   submit, delete, every reel's Remove, AND Create trail while any write is in flight — so
   two writes can't race and Create trail can't snapshot a tray mid-remove. Each write is
   guarded (mounted-ref) and pessimistic: a Remove keeps its row until the write resolves,
   and any rejection keeps this surface open, preserves the in-progress value, releases the
   lock, and shows an inline role="alert".

   Rename validates client-side BEFORE the call (renameCollection does NOT trim/length-check;
   the 1–80 bound is a DB CHECK): trim + 1–80 + case-insensitive dup vs the other trays'
   names, reusing CreateTrayDialog's pattern. It is a full-page surface (early-return in the
   parent), not a modal, so no inert/focus-trap is needed. The reel-label idiom is replicated
   here (feasible-first, no shared abstraction until a third caller). */

const NAME_MAX = 80
const DUPLICATE_HINT = "That name's already used"

function reelLabel(card: SavedReelCard): string {
  return card.personal_label ?? card.caption ?? 'Untitled reel'
}

const ImageIcon = ({ size = 18, opacity = 1 }: { size?: number; opacity?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeOpacity={opacity} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="m21 15-5-5L5 21" />
  </svg>
)

const BTN_PRIMARY =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[color:var(--accent)] bg-[color:var(--accent)] px-4 text-[13px] font-medium text-[color:var(--accent-text)] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]'
const BTN_SECONDARY =
  'inline-flex min-h-11 items-center justify-center rounded-lg border border-[color:var(--paper-line-2)] bg-transparent px-4 text-[13px] font-medium text-[color:var(--text)] transition-colors hover:bg-[color:var(--surface-2)] disabled:cursor-default disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]'
const BTN_DANGER =
  'inline-flex min-h-11 items-center justify-center rounded-lg border border-[color:var(--fail)] bg-transparent px-4 text-[13px] font-medium text-[color:var(--fail)] transition-colors hover:bg-[color:var(--surface-2)] disabled:cursor-default disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]'
const BTN_BACK =
  'mb-4 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-[color:var(--text-muted)] transition-colors hover:text-[color:var(--text)] disabled:cursor-default disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]'

export default function TrayDetail({
  collection,
  cards,
  cardsStatus = 'ready',
  existingNames,
  onRemoveReel,
  onRename,
  onDelete,
  onCreateTrail,
  onBack,
}: {
  collection: ReelCollection
  cards: SavedReelCard[]
  // The parent's saved-reel fetch state. When cards are still loading (or failed), an
  // empty `cards` here is NOT a genuinely-empty tray — distinguish the two so a tray with
  // members never shows "No reels yet" while its covers are mid-flight (Codex M3).
  cardsStatus?: 'loading' | 'error' | 'ready'
  existingNames: string[]
  onRemoveReel: (savedReelId: string) => Promise<void>
  onRename: (name: string) => Promise<void>
  onDelete: () => Promise<void>
  onCreateTrail: () => void
  onBack: () => void
}) {
  const [mutating, setMutating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [renameValue, setRenameValue] = useState(collection.name)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const activeRef = useRef(true)
  useEffect(() => {
    activeRef.current = true
    return () => { activeRef.current = false }
  }, [])

  const trimmedName = renameValue.trim()
  const isDuplicate =
    trimmedName.length > 0 &&
    existingNames.some((n) => n.trim().toLowerCase() === trimmedName.toLowerCase())
  const nameValid = trimmedName.length >= 1 && trimmedName.length <= NAME_MAX && !isDuplicate

  const hasGroundedPlaces = cards.some((card) => card.places.length > 0)
  const createTrailDisabled = mutating || !hasGroundedPlaces
  // Two distinct zero cases: no reels at all vs reels that are not organized/grounded yet.
  const createTrailHint =
    cards.length === 0
      ? 'Add reels to plan a trip'
      : !hasGroundedPlaces
        ? 'Organize these reels first to plan a trip.'
        : null

  // Every write funnels through one guarded runner: it holds the mutation-wide lock, clears
  // any prior error, and on rejection keeps this surface open with an inline error + releases
  // the lock. Callers act on its boolean result (e.g. collapse the rename form only on success).
  async function runMutation(fn: () => Promise<void>): Promise<boolean> {
    setMutating(true)
    setError(null)
    try {
      await fn()
      return true
    } catch (err) {
      if (activeRef.current) setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      return false
    } finally {
      if (activeRef.current) setMutating(false)
    }
  }

  function startRename() {
    setRenameValue(collection.name)
    setError(null)
    setEditing(true)
  }

  async function submitRename() {
    if (mutating || !nameValid) return
    const ok = await runMutation(() => onRename(trimmedName))
    if (ok && activeRef.current) setEditing(false)
  }

  async function handleRemove(savedReelId: string) {
    if (mutating) return
    await runMutation(() => onRemoveReel(savedReelId))
  }

  async function confirmDelete() {
    if (mutating) return
    // On success the parent unmounts this surface (returns to the grid); on failure the
    // confirm stays open with an inline error so the user can retry.
    await runMutation(() => onDelete())
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col">
      <header className="mb-6">
        <button type="button" disabled={mutating} onClick={onBack} className={BTN_BACK}>
          <span aria-hidden>←</span> Back
        </button>

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            {editing ? (
              <form
                onSubmit={(e) => { e.preventDefault(); void submitRename() }}
                className="flex flex-wrap items-center gap-2"
              >
                <label htmlFor="tray-rename" className="sr-only">Tray name</label>
                <input
                  id="tray-rename"
                  type="text"
                  value={renameValue}
                  disabled={mutating}
                  autoFocus
                  maxLength={NAME_MAX}
                  onChange={(e) => setRenameValue(e.target.value)}
                  aria-invalid={isDuplicate}
                  className="min-h-11 min-w-0 flex-1 rounded-lg border border-[color:var(--line-soft)] bg-[color:var(--surface-1)] px-4 text-[color:var(--text)] placeholder:text-[color:var(--text-faint)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)] disabled:cursor-default disabled:opacity-60"
                />
                <button type="submit" disabled={mutating || !nameValid} className={BTN_PRIMARY}>Save</button>
                <button
                  type="button"
                  disabled={mutating}
                  onClick={() => { setEditing(false); setError(null) }}
                  className={BTN_SECONDARY}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="min-w-0 truncate font-display text-[26px] font-medium tracking-[-0.01em] text-[color:var(--text)]">
                  {collection.name}
                </h1>
                <button type="button" disabled={mutating} onClick={startRename} className={BTN_SECONDARY}>
                  Rename
                </button>
              </div>
            )}
            {editing && isDuplicate ? (
              <p className="mt-1.5 text-[12px] text-[color:var(--text-muted)]">{DUPLICATE_HINT}</p>
            ) : (
              <p className="mt-1.5 text-[13px] text-[color:var(--text-muted)]">
                {cards.length} {cards.length === 1 ? 'reel' : 'reels'}
              </p>
            )}
          </div>

          {confirmingDelete ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] text-[color:var(--text-muted)]">Delete this tray?</span>
              <button type="button" disabled={mutating} onClick={() => void confirmDelete()} className={BTN_DANGER}>
                Confirm delete
              </button>
              <button
                type="button"
                disabled={mutating}
                onClick={() => setConfirmingDelete(false)}
                className={BTN_SECONDARY}
              >
                Keep tray
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={mutating}
              onClick={() => { setConfirmingDelete(true); setError(null) }}
              className={BTN_DANGER}
            >
              Delete tray
            </button>
          )}
        </div>
      </header>

      {error ? (
        <p role="alert" className="mb-4 rounded-lg border border-dashed border-[color:var(--line-soft)] bg-[color:var(--surface-2)] p-3 text-[13px] text-[color:var(--text-muted)]">
          {error}
        </p>
      ) : null}

      {/* Reels list */}
      {cards.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-[color:var(--line-soft)] px-6 py-16 text-center text-[14px] text-[color:var(--text-muted)]">
          {cardsStatus === 'loading'
            ? "Loading this tray's reels…"
            : cardsStatus === 'error'
              ? "We could not load this tray's reels just now."
              : 'No reels in this tray yet.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {cards.map((card) => {
            const label = reelLabel(card)
            return (
              <li
                key={card.id}
                className="flex items-center gap-4 rounded-xl border border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)] p-3"
              >
                <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[color:var(--surface-2)] text-[color:var(--brass-deep)]">
                  {card.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={card.thumbnail_url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <ImageIcon opacity={0.4} />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-[color:var(--text)]">
                  {label}
                </span>
                <button
                  type="button"
                  disabled={mutating}
                  aria-label={`Remove ${label}`}
                  onClick={() => void handleRemove(card.id)}
                  className={BTN_SECONDARY}
                >
                  Remove
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {/* Create trail */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button type="button" disabled={createTrailDisabled} onClick={onCreateTrail} className={BTN_PRIMARY}>
          Create trail
        </button>
        {createTrailHint ? (
          <span className="text-[13px] text-[color:var(--text-muted)]">{createTrailHint}</span>
        ) : null}
      </div>
    </div>
  )
}
