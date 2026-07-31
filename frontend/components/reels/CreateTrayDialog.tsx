'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { addReelsToCollection, createCollection } from '@/lib/reels/collections'
import type { SavedReelCard } from '@/lib/reels/backend-types'

/* CreateTrayDialog — a lightweight accessible modal to name a new tray and (optionally) pick
   reels for it, then create it via the data layer. Replaces TraysScreen's interim createOpen
   placeholder.

   Create is non-atomic (§11 B1): createCollection then, if any reels are picked,
   addReelsToCollection. If the membership write fails after the tray exists, we do NOT orphan
   or delete the (empty) tray — we keep its id, refresh the grid so it appears, surface the
   error, and let the user Retry the attachment against the SAME stored id (re-running
   createCollection would 23505 on the unique name). A concurrent unique-name collision from
   createCollection maps to the same "already used" message the client-side disable shows.

   DEFERRED, intentionally OUT of v1 (reel_collections only has name, sort_order): tray
   description, public/private visibility, and AI auto-add. */

function reelLabel(card: SavedReelCard): string {
  return card.personal_label ?? card.caption ?? 'Untitled reel'
}

// The data layer wraps a Postgres unique-violation (23505) into a friendly Error; a raw
// PostgrestError could also leak a `code`. Detect both so the concurrent collision reads as
// the same "already used" hint the client-side disable uses (the DB is the source of truth).
function isDuplicateNameError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') return true
  // Match ONLY the exact phrase collectionWriteError emits for a 23505 (`… already exists.`).
  // The broad /duplicate|unique/ would mislabel unrelated Postgres errors whose text happens to
  // contain those words; the `.code === '23505'` branch above stays the primary/defensive guard.
  const message = err instanceof Error ? err.message.toLowerCase() : ''
  return /already exists/.test(message)
}

const NAME_MAX = 80
const DUPLICATE_HINT = "That name's already used"

const BTN_PRIMARY =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[color:var(--accent)] bg-[color:var(--accent)] px-4 text-[13px] font-medium text-[color:var(--accent-text)] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]'
const BTN_SECONDARY =
  'inline-flex min-h-11 items-center justify-center rounded-lg border border-[color:var(--paper-line-2)] bg-transparent px-4 text-[13px] font-medium text-[color:var(--text)] transition-colors hover:bg-[color:var(--surface-2)] disabled:cursor-default disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]'
const CHIP_BASE =
  'inline-flex min-h-11 items-center rounded-full border px-4 text-[13px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]'
const CHIP_ON = 'border-[color:var(--accent)] bg-[color:var(--accent)] text-[color:var(--accent-text)]'
const CHIP_OFF = 'border-[color:var(--paper-line-2)] bg-transparent text-[color:var(--text)] hover:bg-[color:var(--surface-2)]'

export default function CreateTrayDialog({
  cards,
  existingNames,
  preselectedReelIds = [],
  onCreated,
  onClose,
}: {
  cards: SavedReelCard[]
  existingNames: string[]
  preselectedReelIds?: string[]
  onCreated: () => void | Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [country, setCountry] = useState<string | null>(null)
  // Lazy initializer runs once at mount and COPIES the prop, so later toggleSelect edits
  // never mutate the caller's array; a fresh dialog mount seeds from the current preselect.
  const [selected, setSelected] = useState<string[]>(() => [...preselectedReelIds])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set once createCollection succeeds. Its presence means the tray exists; a Retry after a
  // partial membership failure must reuse it and skip createCollection (unique-name guard).
  const [createdId, setCreatedId] = useState<string | null>(null)

  const nameInputRef = useRef<HTMLInputElement>(null)
  const activeRef = useRef(true)
  useEffect(() => {
    activeRef.current = true
    nameInputRef.current?.focus() // autofocus the name field on open
    return () => { activeRef.current = false }
  }, [])

  const trimmedName = name.trim()
  const isDuplicate =
    trimmedName.length > 0 &&
    existingNames.some((n) => n.trim().toLowerCase() === trimmedName.toLowerCase())
  const nameValid = trimmedName.length >= 1 && trimmedName.length <= NAME_MAX && !isDuplicate
  // Once the tray exists (retry state), the name is already fixed on the server, so a Retry
  // stays enabled regardless of the field; otherwise a valid, non-duplicate name is required.
  const canSubmit = !busy && (createdId !== null || nameValid)

  // Country chips derived from every card's places (code → display name), matching LibraryPanel.
  const countries = useMemo(() => {
    const byCode = new Map<string, string>()
    for (const c of cards) {
      for (const p of c.places) {
        if (!byCode.has(p.country_code)) byCode.set(p.country_code, p.country_name || p.country_code)
      }
    }
    return Array.from(byCode, ([code, label]) => ({ code, label })).sort((a, b) => a.label.localeCompare(b.label))
  }, [cards])

  const filtered = useMemo(
    () => cards.filter((c) => !country || c.places.some((p) => p.country_code === country)),
    [cards, country],
  )

  function toggleSelect(id: string) {
    // No selection cap: a tray holds any number of reels (the ≤5 cap is only for trip generation).
    setSelected((current) => (current.includes(id) ? current.filter((v) => v !== id) : [...current, id]))
  }

  async function submit() {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      let collectionId = createdId
      if (!collectionId) {
        const created = await createCollection(trimmedName)
        if (!activeRef.current) return
        collectionId = created.id
        setCreatedId(collectionId)
      }

      if (selected.length > 0) {
        try {
          await addReelsToCollection(collectionId, selected)
        } catch {
          // Non-atomic partial failure: the tray exists (empty), the reels did not attach.
          // Keep it, refresh the grid so it appears, surface the error, and allow a Retry
          // that re-attaches against the same id (never re-creating).
          if (!activeRef.current) return
          await onCreated()
          if (!activeRef.current) return
          setError("Tray created, but we couldn't add your reels — try again.")
          setBusy(false)
          return
        }
      }

      if (!activeRef.current) return
      await onCreated()
      if (!activeRef.current) return
      onClose()
    } catch (err) {
      if (!activeRef.current) return
      setError(
        isDuplicateNameError(err)
          ? DUPLICATE_HINT
          : err instanceof Error
            ? err.message
            : 'Could not create the tray.',
      )
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(28,23,16,0.45)] p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-tray-heading"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)] shadow-[var(--shadow-paper)]"
      >
        <header className="border-b border-[color:var(--line-soft)] px-6 py-5">
          <h2 id="create-tray-heading" className="font-display text-[20px] font-medium tracking-[-0.01em] text-[color:var(--text)]">
            Name a new tray
          </h2>
          <p className="mt-1 text-[13px] text-[color:var(--text-muted)]">
            Name it, and optionally pick the reels to start it with.
          </p>
        </header>

        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
          {/* Name field */}
          <div>
            <label htmlFor="tray-name" className="mb-1.5 block text-[13px] font-medium text-[color:var(--text)]">
              Tray name
            </label>
            <input
              id="tray-name"
              ref={nameInputRef}
              type="text"
              value={name}
              maxLength={NAME_MAX}
              // Once the tray exists (retry state) the name is fixed on the server, so a Retry
              // ignores field edits — lock and mute the input to stop the misleading dup hint next
              // to an edit-proof Retry.
              disabled={createdId !== null}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tokyo winter 2026"
              aria-invalid={isDuplicate}
              className="min-h-11 w-full rounded-lg border border-[color:var(--line-soft)] bg-[color:var(--surface-1)] px-4 text-[color:var(--text)] placeholder:text-[color:var(--text-faint)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)] disabled:cursor-default disabled:opacity-60"
            />
            {isDuplicate ? (
              <p className="mt-1.5 text-[12px] text-[color:var(--text-muted)]">{DUPLICATE_HINT}</p>
            ) : null}
          </div>

          {/* Reel picker */}
          {cards.length > 0 ? (
            <div>
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[13px] font-medium text-[color:var(--text)]">Add reels (optional)</span>
                <span className="text-[12px] text-[color:var(--text-muted)]">{selected.length} selected</span>
              </div>

              {countries.length > 0 ? (
                <div className="mb-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    aria-pressed={country === null}
                    onClick={() => setCountry(null)}
                    className={`${CHIP_BASE} ${country === null ? CHIP_ON : CHIP_OFF}`}
                  >
                    All
                  </button>
                  {countries.map((c) => (
                    <button
                      key={c.code}
                      type="button"
                      aria-pressed={country === c.code}
                      onClick={() => setCountry(c.code)}
                      className={`${CHIP_BASE} ${country === c.code ? CHIP_ON : CHIP_OFF}`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              ) : null}

              <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
                {filtered.map((c) => {
                  const on = selected.includes(c.id)
                  const label = reelLabel(c)
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        aria-pressed={on}
                        aria-label={`Select ${label}`}
                        onClick={() => toggleSelect(c.id)}
                        className={`w-full overflow-hidden rounded-lg border text-left transition-transform hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)] ${
                          on ? 'border-[color:var(--accent)]' : 'border-[color:var(--paper-line-2)]'
                        }`}
                      >
                        <div className="relative aspect-[9/16] bg-[color:var(--surface-2)]">
                          {c.thumbnail_url ? (
                            /* eslint-disable-next-line @next/next/no-img-element */
                            <img src={c.thumbnail_url} alt="" className="h-full w-full object-cover" />
                          ) : null}
                          <span
                            aria-hidden
                            className={`absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border text-[11px] ${
                              on
                                ? 'border-[color:var(--accent)] bg-[color:var(--accent)] text-[color:var(--accent-text)]'
                                : 'border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)]'
                            }`}
                          >
                            {on ? '✓' : ''}
                          </span>
                        </div>
                        <span className="block truncate px-3 py-2 text-[13px] text-[color:var(--text)]">{label}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="rounded-lg border border-dashed border-[color:var(--line-soft)] bg-[color:var(--surface-2)] p-3 text-[13px] text-[color:var(--text-muted)]">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-3 border-t border-[color:var(--line-soft)] px-6 py-4">
          <button type="button" className={BTN_SECONDARY} onClick={onClose}>Cancel</button>
          <button type="button" disabled={!canSubmit} className={BTN_PRIMARY} onClick={() => void submit()}>
            {createdId ? 'Retry' : 'Create'}
          </button>
        </footer>
      </div>
    </div>
  )
}
