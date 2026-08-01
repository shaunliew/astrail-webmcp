'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  addReelsToCollection,
  deleteCollection,
  getMembershipsByCollection,
  listCollections,
  removeReelFromCollection,
  renameCollection,
} from '@/lib/reels/collections'
import type { ReelCollection, SavedReelCard } from '@/lib/reels/backend-types'
import TrayCard, { type TrayCover } from './TrayCard'
import TrayDetail from './TrayDetail'
import LibraryPanel from './LibraryPanel'
import CreateTrayDialog from './CreateTrayDialog'
import ReelInfoCard from './ReelInfoCard'

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
  cardsStatus = 'ready',
  onCapture,
  onOrganize,
  onCreateTrail,
}: {
  cards: SavedReelCard[]
  // Parent's saved-reel fetch state; forwarded to TrayDetail so an in-flight/failed cards
  // load doesn't read as an empty tray. Tray COUNTS come from membership (below), not cards.
  cardsStatus?: 'loading' | 'error' | 'ready'
  onCapture: (url: string) => Promise<void>
  onOrganize: (ids: string[]) => Promise<void>
  onCreateTrail: (trayCards: SavedReelCard[]) => void
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
  const [viewingReel, setViewingReel] = useState<SavedReelCard | null>(null)
  // Key the open tray by ID (Decision 4), never the object: the collection is derived from
  // `collections` state below, so a rename re-renders the shown name instead of going stale.
  const [openTrayId, setOpenTrayId] = useState<string | null>(null)
  // Seeds CreateTrayDialog's picker when "New tray…" is chosen from an open reel (T2.1c);
  // reset to [] on dialog close so it never leaks into an ordinary "New tray" open.
  const [createPreselect, setCreatePreselect] = useState<string[]>([])
  const activeRef = useRef(true)
  // Monotonic refresh id: overlapping refreshes (e.g. two adds from separate reel-card
  // instances, one opened after Escaping the other) can resolve out of order. Only the newest
  // refresh may write state, so a stale read can never overwrite newer membership (Codex race).
  const refreshGenRef = useRef(0)

  // Single source of truth for collections. Exposed so T1.4's CreateTrayDialog can
  // re-sync the grid after a create/add without a full remount.
  async function refresh() {
    const gen = ++refreshGenRef.current
    setLoading(true)
    setError(null)
    try {
      const [nextCollections, memberships] = await Promise.all([listCollections(), getMembershipsByCollection()])
      if (!activeRef.current || gen !== refreshGenRef.current) return // superseded by a newer refresh
      setCollections(nextCollections)
      setMembershipByCollection(memberships)
    } catch {
      // Never crash the home on a trays fetch failure — keep capture + Library usable.
      if (activeRef.current && gen === refreshGenRef.current) setError('We could not load your trays just now. Your saved Reels are still here.')
    } finally {
      if (activeRef.current && gen === refreshGenRef.current) setLoading(false)
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

  // Open a tray into TrayDetail (Decision 4): store only the id, derive the collection below.
  function handleOpenTray(collection: ReelCollection) { setOpenTrayId(collection.id) }

  // P2 (T2.1) — opening a reel from the Library shows the reel-info card overlay.
  function handleOpenReel(card: SavedReelCard) { setViewingReel(card) }

  // Gate the empty state on the absence of an error too: a transient trays-fetch failure must
  // surface the error banner, not the misleading "No trails yet" state (they'd otherwise co-render).
  const isEmpty = !loading && !error && cards.length === 0 && collections.length === 0

  const traysWithReel = useMemo(
    () =>
      new Set(
        viewingReel
          ? collections.filter((c) => (membershipByCollection[c.id] ?? []).includes(viewingReel.id)).map((c) => c.id)
          : [],
      ),
    [collections, membershipByCollection, viewingReel],
  )

  // Built once and rendered in BOTH return branches — the reel is opened from the Library
  // early-return, so it must float over that branch too (fixed inset-0 z-50 handles the layering).
  const reelOverlay = viewingReel ? (
    <ReelInfoCard
      card={viewingReel}
      collections={collections}
      traysState={loading ? 'loading' : error ? 'error' : 'ready'}
      traysWithReel={traysWithReel}
      onAddToTray={async (id) => { await addReelsToCollection(id, [viewingReel.id]); await refresh() }}
      onRequestNewTray={() => { setCreatePreselect([viewingReel.id]); setViewingReel(null); setLibraryOpen(false); setCreateOpen(true) }}
      onClose={() => setViewingReel(null)}
    />
  ) : null

  // TrayDetail early-return (Decision 4) — derive the open tray from state (never a stored
  // object) so a rename re-renders its name; if the tray vanished (deleted elsewhere) openTray
  // is undefined → fall through to the grid. Placed BEFORE the Library early-return: a tray is
  // only ever opened from the ungated grid, so no both-branches overlay trick is needed.
  const openTray = collections.find((c) => c.id === openTrayId)
  if (openTray) {
    const trayCards = (membershipByCollection[openTray.id] ?? [])
      .map((id) => cardById.get(id))
      .filter((card): card is SavedReelCard => Boolean(card))
    return (
      <TrayDetail
        collection={openTray}
        cards={trayCards}
        cardsStatus={cardsStatus}
        existingNames={collections.filter((c) => c.id !== openTray.id).map((c) => c.name)}
        onRemoveReel={async (rid) => {
          await removeReelFromCollection(openTray.id, rid)
          // Reconcile locally on success, then refresh best-effort (Decision 5): refresh()
          // swallows read failures, so a bare await-refresh could resurrect the removed member.
          if (activeRef.current) {
            setMembershipByCollection((prev) => ({
              ...prev,
              [openTray.id]: (prev[openTray.id] ?? []).filter((id) => id !== rid),
            }))
          }
          await refresh()
        }}
        onRename={async (newName) => {
          const updated = await renameCollection(openTray.id, newName)
          if (activeRef.current) {
            setCollections((prev) => prev.map((c) => (c.id === openTray.id ? { ...c, name: updated.name } : c)))
          }
          await refresh()
        }}
        onDelete={async () => {
          await deleteCollection(openTray.id)
          if (activeRef.current) {
            setOpenTrayId(null)
            setCollections((prev) => prev.filter((c) => c.id !== openTray.id))
            setMembershipByCollection((prev) => {
              const next = { ...prev }
              delete next[openTray.id]
              return next
            })
          }
          await refresh()
        }}
        onCreateTrail={() => onCreateTrail(trayCards)}
        onBack={() => setOpenTrayId(null)}
      />
    )
  }

  // Full-surface swap: the Library replaces the home content (greeting/capture/banner/trays)
  // rather than expanding inline. The /app home has no map behind it, so this is a plain
  // paper panel, not a fixed inset-0 overlay. While a reel card floats over it, the Library
  // is made `inert` (C2) so focus and its Back control can't be reached under the modal.
  if (libraryOpen) {
    return (
      <>
        <div inert={viewingReel !== null}>
          <LibraryPanel
            cards={cards}
            onClose={() => setLibraryOpen(false)}
            onOpenReel={handleOpenReel}
            onOrganize={onOrganize}
          />
        </div>
        {reelOverlay}
      </>
    )
  }

  return (
    <>
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
                const photos: TrayCover[] = memberIds
                  .map((id) => cardById.get(id))
                  .filter((card): card is SavedReelCard => Boolean(card))
                  .map((card) => ({ id: card.id, image: card.thumbnail_url ?? null, alt: card.personal_label ?? card.caption ?? '' }))
                return (
                  <TrayCard
                    key={collection.id}
                    collection={collection}
                    // Count from membership (source of truth), NOT resolved covers — so a
                    // tray with members never shows "0 reels" while cards load/fail (M3).
                    reelCount={memberIds.length}
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
                className="flex min-h-[264px] flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[color:var(--paper-line-2)] bg-transparent text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--surface-2)] hover:text-[color:var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]"
              >
                <span aria-hidden className="flex h-12 w-12 items-center justify-center rounded-full border border-[color:var(--brass-deep)] text-[24px] leading-none text-[color:var(--brass-deep)]">+</span>
                <span className="text-[14px] font-medium">New tray</span>
              </button>
            </div>

            {createOpen ? (
              <CreateTrayDialog
                cards={cards}
                existingNames={collections.map((c) => c.name)}
                preselectedReelIds={createPreselect}
                onCreated={refresh}
                onClose={() => { setCreateOpen(false); setCreatePreselect([]) }}
              />
            ) : null}
          </section>
        </>
      )}
    </div>
    {reelOverlay}
    </>
  )
}
