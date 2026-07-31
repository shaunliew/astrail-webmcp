'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getMembershipsByCollection, listCollections } from '@/lib/reels/collections'
import type { ReelCollection, SavedReelCard } from '@/lib/reels/backend-types'
import type { FolderPhoto } from '@/components/ui/folder-gallery'
import TrayCard from './TrayCard'
import LibraryPanel from './LibraryPanel'
import CreateTrayDialog from './CreateTrayDialog'

/* TraysScreen — the /app home. Replaces the old DashboardHome inbox body with:
   greeting + quick-capture + a Library banner + a "Your trays" grid (one TrayCard per
   collection + a create tile) + empty state.

   It is the single source of truth for collections state (list + per-collection
   membership); TrayCard renders each tray's cover from that state. It carries the SAME
   { cards, onCapture, onOrganize } contract DashboardHome had, because SavedReelsFlow is
   the only wiring for those callbacks and the capture→organize→generate journey must
   survive (plan T1.2 / B2 / DECISION B). LibraryPanel (T1.3) and CreateTrayDialog (T1.4)
   are not built yet, so their seams here are interim placeholders, not the real panels. */

const BTN_PRIMARY =
  'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[color:var(--accent)] bg-[color:var(--accent)] px-4 text-[13px] font-medium text-[color:var(--accent-text)] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]'

export default function TraysScreen({
  cards,
  onCapture,
  onOrganize,
}: {
  cards: SavedReelCard[]
  onCapture: (url: string) => Promise<void>
  onOrganize: (ids: string[]) => Promise<void>
}) {
  const [name, setName] = useState('traveler')
  const [collections, setCollections] = useState<ReelCollection[]>([])
  const [membershipByCollection, setMembershipByCollection] = useState<Record<string, string[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const activeRef = useRef(true)

  // Single source of truth for collections. Exposed so T1.4's CreateTrayDialog can
  // re-sync the grid after a create/add without a full remount.
  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const [nextCollections, memberships] = await Promise.all([listCollections(), getMembershipsByCollection()])
      if (!activeRef.current) return
      setCollections(nextCollections)
      setMembershipByCollection(memberships)
    } catch {
      // Never crash the home on a trays fetch failure — keep capture + Library usable.
      if (activeRef.current) setError('We could not load your trays just now. Your saved Reels are still here.')
    } finally {
      if (activeRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    activeRef.current = true
    createClient()
      .auth.getUser()
      .then(({ data }) => {
        if (!activeRef.current) return
        const meta = data.user?.user_metadata as { full_name?: string; name?: string } | undefined
        const fallback = data.user?.email?.split('@')[0]
        // The doubled greeting some accounts show is a data artifact in full_name, not a
        // code bug — render it once, exactly as DashboardHome did.
        setName(meta?.full_name ?? meta?.name ?? fallback ?? 'traveler')
      })
      .catch(() => {})
    void refresh()
    return () => { activeRef.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cardById = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards])

  async function capture() {
    if (!url.trim()) return
    setBusy(true); setMessage(null)
    try {
      await onCapture(url.trim())
      if (!activeRef.current) return
      setUrl(''); setMessage('Saved to your library.')
    } catch (err) {
      if (activeRef.current) setMessage(err instanceof Error ? err.message : 'Could not save that Reel.')
    } finally {
      if (activeRef.current) setBusy(false)
    }
  }

  // Phase 3 (T3.1) wires TrayDetail; for now Open is a stubbed seam the parent owns.
  function handleOpenTray(_collection: ReelCollection) { /* T3.1 wires TrayDetail (plan Phase 3) */ }

  // P2 (T2.1) wires ReelInfoCard; opening a reel from the Library is a no-op stub in P1.
  function handleOpenReel(_card: SavedReelCard) { /* T2.1 wires ReelInfoCard (plan Phase 2) */ }

  const isEmpty = !loading && cards.length === 0 && collections.length === 0

  // Full-surface swap: the Library replaces the home content (greeting/capture/banner/trays)
  // rather than expanding inline. The /app home has no map behind it, so this is a plain
  // paper panel, not a fixed inset-0 overlay.
  if (libraryOpen) {
    return (
      <LibraryPanel
        cards={cards}
        onClose={() => setLibraryOpen(false)}
        onOpenReel={handleOpenReel}
        onOrganize={onOrganize}
      />
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col">
      <header className="mb-8">
        <p className="text-[13px] text-[color:var(--text-muted)]">Welcome back,</p>
        <span
          className="mt-1 block font-display text-[28px] font-medium leading-tight tracking-[-0.01em] text-[color:var(--text)]"
          style={{ fontVariationSettings: "'SOFT' 28, 'WONK' 0, 'opsz' 28" }}
        >
          {name}
        </span>
      </header>

      {/* Quick capture — always available (lifted from DashboardHome). */}
      <form
        onSubmit={(e) => { e.preventDefault(); void capture() }}
        className="mb-6 flex items-center gap-3 rounded-2xl border border-dashed border-[color:var(--line-soft)] bg-[color:var(--surface-2)] p-3"
      >
        <label htmlFor="capture-input" className="sr-only">Paste a Reel link</label>
        <input
          id="capture-input"
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste an Instagram Reel link to save it for later…"
          className="min-h-11 flex-1 rounded-lg border border-[color:var(--line-soft)] bg-[color:var(--surface-1)] px-4 text-[color:var(--text)] placeholder:text-[color:var(--text-faint)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]"
        />
        <button type="submit" disabled={busy || !url.trim()} className={BTN_PRIMARY}>Save</button>
      </form>
      {message ? <p role="status" className="-mt-3 mb-6 text-[13px] text-[color:var(--text-muted)]">{message}</p> : null}
      {error ? (
        <p role="alert" className="mb-6 rounded-lg border border-dashed border-[color:var(--line-soft)] bg-[color:var(--surface-2)] p-3 text-[13px] text-[color:var(--text-muted)]">
          {error}
        </p>
      ) : null}

      {isEmpty ? (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-[color:var(--line-soft)] px-6 py-16 text-center">
          <span aria-hidden className="h-[72px] w-[72px] rounded-full border border-dashed border-[color:var(--line-soft)]" />
          <h2 className="font-display text-[18px] font-medium text-[color:var(--text)]">No trails yet</h2>
          <p className="max-w-[42ch] text-[14px] text-[color:var(--text-muted)]">
            Paste the Reels you saved and Astrail will pull out the real places, check they exist, and connect them into a route you can follow.
          </p>
        </div>
      ) : (
        <>
          {/* Library banner — the doorway into every saved reel. Opens the full-surface
              LibraryPanel (T1.3), which owns filter/search/browse-fan/select→organize. */}
          <button
            type="button"
            onClick={() => setLibraryOpen(true)}
            className="mb-8 flex w-full items-center justify-between gap-4 rounded-2xl border border-[color:var(--brass-deep)] bg-[color:var(--brass-wash)] px-6 py-7 text-left transition-colors hover:bg-[color:var(--surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]"
          >
            <span>
              <span className="block font-display text-[20px] font-medium text-[color:var(--text)]">Your inspiration starts here</span>
              <span className="mt-1 block text-[13px] text-[color:var(--text-muted)]">Every reel you saved, in one place.</span>
            </span>
            <span aria-hidden className="text-[13px] font-medium text-[color:var(--brass-deep)]">Open</span>
          </button>

          {/* Your trays */}
          <section>
            <div className="mb-4 flex items-baseline justify-between gap-4">
              <h2 className="font-display text-[18px] font-medium text-[color:var(--text)]">Your trays</h2>
              <span className="text-[13px] text-[color:var(--text-faint)]">{collections.length} {collections.length === 1 ? 'tray' : 'trays'}</span>
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {collections.map((collection) => {
                const memberIds = membershipByCollection[collection.id] ?? []
                const photos: FolderPhoto[] = memberIds
                  .map((id) => cardById.get(id))
                  .filter((card): card is SavedReelCard => Boolean(card))
                  .map((card) => ({ id: card.id, image: card.thumbnail_url ?? null, alt: card.personal_label ?? card.caption ?? '' }))
                return (
                  <TrayCard
                    key={collection.id}
                    collection={collection}
                    reelCount={photos.length}
                    photos={photos}
                    onOpen={handleOpenTray}
                  />
                )
              })}

              {/* Create tile */}
              <button
                type="button"
                onClick={() => setCreateOpen(true)}
                aria-label="Create a tray"
                className="flex min-h-[280px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[color:var(--paper-line-2)] bg-transparent text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--surface-2)] hover:text-[color:var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]"
              >
                <span aria-hidden className="flex h-12 w-12 items-center justify-center rounded-full border border-[color:var(--brass-deep)] text-[24px] leading-none text-[color:var(--brass-deep)]">+</span>
                <span className="text-[14px] font-medium">New tray</span>
              </button>
            </div>

            {createOpen ? (
              <CreateTrayDialog
                cards={cards}
                existingNames={collections.map((c) => c.name)}
                onCreated={refresh}
                onClose={() => setCreateOpen(false)}
              />
            ) : null}
          </section>
        </>
      )}
    </div>
  )
}
