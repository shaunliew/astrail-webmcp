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

// Quick capture takes up to 5 links per save — the same cap as MAX_REELS on trip
// generation, so one batch of pastes can feed a full trip. Each link still goes through
// the one-URL capture endpoint sequentially; the backend contract is unchanged.
const MAX_CAPTURE_LINKS = 5

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
  // Which mode the library should open in — 'select' when the user pressed "Plan a trip".
  const [libraryMode, setLibraryMode] = useState<'browse' | 'select'>('browse')
  const [createOpen, setCreateOpen] = useState(false)
  const [urls, setUrls] = useState<string[]>([''])
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

  /**
   * Spread a multi-link paste across the rows.
   *
   * People copy Reels in batches — from notes, a chat, a share sheet — and arrive with several
   * links separated by newlines or spaces. The form took one link per row and made you click
   * "+ Add another link" for each, which is exactly the copy-paste friction this product exists
   * to remove. A paste containing more than one link now fills the rows itself.
   */
  function spreadPastedLinks(index: number, raw: string): boolean {
    const found = raw.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean)
    if (found.length < 2) return false
    setUrls((prev) => {
      const next = [...prev]
      next[index] = found[0]
      // Fill blank rows first so a half-typed row is never overwritten, then append.
      for (const link of found.slice(1)) {
        if (next.length >= MAX_CAPTURE_LINKS) break
        const blank = next.findIndex((u, j) => j > index && !u.trim())
        if (blank >= 0) next[blank] = link
        else next.push(link)
      }
      return next
    })
    return true
  }

  async function capture() {
    const targets = urls.map((u) => u.trim())
    if (!targets.some(Boolean)) return
    setBusy(true); setMessage(null)
    // Save one link per request (the capture endpoint takes a single URL). Failed links
    // stay in their rows with the first error surfaced, so the user can fix and retry;
    // saved and duplicate rows are cleared.
    const kept: string[] = []
    const failures: string[] = []
    const seen = new Set<string>()
    let saved = 0
    try {
      for (let i = 0; i < targets.length; i++) {
        const target = targets[i]
        if (!target || seen.has(target)) continue
        seen.add(target)
        try {
          await onCapture(target)
          saved++
        } catch (err) {
          kept.push(urls[i])
          failures.push(err instanceof Error ? err.message : 'Could not save that link.')
        }
        if (!activeRef.current) return
      }
      setUrls(kept.length ? kept : [''])
      if (!failures.length) {
        setMessage(saved > 1 ? `Saved ${saved} links to your library.` : 'Saved to your library.')
      } else if (saved === 0) {
        setMessage(failures.length > 1 ? `${failures[0]} (${failures.length} links failed.)` : failures[0])
      } else {
        setMessage(`Saved ${saved} of ${saved + failures.length} links. ${failures[0]}`)
      }
    } finally {
      if (activeRef.current) setBusy(false)
    }
  }

  // Open a tray into TrayDetail (Decision 4): store only the id, derive the collection below.
  function handleOpenTray(collection: ReelCollection) { setOpenTrayId(collection.id) }

  // P2 (T2.1) — opening a reel from the Library shows the reel-info card overlay.
  function handleOpenReel(card: SavedReelCard) { setViewingReel(card) }

  // Gate the empty state on the absence of an error too: a transient trays-fetch failure must
  // surface the error banner, not the misleading empty state (they'd otherwise co-render).
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
    const openMemberIds = membershipByCollection[openTray.id] ?? []
    const trayCards = openMemberIds
      .map((id) => cardById.get(id))
      .filter((card): card is SavedReelCard => Boolean(card))
    return (
      <TrayDetail
        collection={openTray}
        cards={trayCards}
        cardsStatus={cardsStatus}
        memberCount={openMemberIds.length}
        onOrganize={onOrganize}
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
            onClose={() => { setLibraryOpen(false); setLibraryMode('browse') }}
            onOpenReel={handleOpenReel}
            onOrganize={onOrganize}
            initialMode={libraryMode}
          />
        </div>
        {reelOverlay}
      </>
    )
  }

  return (
    <>
    <div className="mx-auto flex w-full max-w-5xl flex-col">
      <header className="mb-10">
        <p className="text-[14px] text-[color:var(--text-muted)]">Welcome back,</p>
        <span
          className="mt-1.5 block font-display text-[36px] font-medium leading-[1.1] tracking-[-0.015em] text-[color:var(--text)]"
          style={{ fontVariationSettings: "'SOFT' 36, 'WONK' 0, 'opsz' 36" }}
        >
          {name}
        </span>
      </header>

      {/* Quick capture — always available (lifted from DashboardHome). Holds up to
          MAX_CAPTURE_LINKS link rows; the "+" below adds a row, Save submits them all. */}
      <form
        onSubmit={(e) => { e.preventDefault(); void capture() }}
        className="mb-6 flex flex-col gap-2 rounded-2xl border border-dashed border-[color:var(--line-soft)] bg-[color:var(--surface-2)] p-3"
      >
        {urls.map((value, i) => (
          <div key={i} className="flex items-center gap-3">
            <label htmlFor={`capture-input-${i}`} className="sr-only">
              {i === 0 ? 'Paste a Reel or post link' : `Paste a Reel or post link ${i + 1}`}
            </label>
            <input
              id={`capture-input-${i}`}
              type="url"
              value={value}
              onChange={(e) => setUrls((prev) => prev.map((u, j) => (j === i ? e.target.value : u)))}
              onPaste={(e) => {
                const text = e.clipboardData.getData('text')
                if (spreadPastedLinks(i, text)) e.preventDefault()
              }}
              placeholder={i === 0 ? 'Paste an Instagram Reel or post link to save it for later…' : 'Paste another Reel or post link…'}
              className="min-h-11 flex-1 rounded-lg border border-[color:var(--line-soft)] bg-[color:var(--surface-1)] px-4 text-[color:var(--text)] placeholder:text-[color:var(--text-faint)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]"
            />
            {i === 0 ? (
              <button type="submit" disabled={busy || !urls.some((u) => u.trim())} className={BTN_PRIMARY}>Save</button>
            ) : (
              <button
                type="button"
                onClick={() => setUrls((prev) => prev.filter((_, j) => j !== i))}
                aria-label={`Remove link ${i + 1}`}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-[color:var(--text-faint)] transition-colors hover:text-[color:var(--text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]"
              >
                ✕
              </button>
            )}
          </div>
        ))}
        {cards.length > 0 ? (
          /* After a successful save the home screen said nothing about what to do next: you had
             to guess that the inspiration banner was the door, then find an unlabelled
             Browse/Select toggle inside it. Four non-obvious steps before anything happened.
             This is the "start here" the screen was missing, and it lands in select mode. */
          <button
            type="button"
            onClick={() => { setLibraryMode('select'); setLibraryOpen(true) }}
            className="mt-4 w-full rounded-full bg-[color:var(--brass-deep)] px-4 py-2.5 text-sm font-semibold text-[color:var(--paper-0)] transition hover:opacity-90"
          >
            Plan a trip from your {cards.length} saved {cards.length === 1 ? 'reel' : 'reels'}
          </button>
        ) : null}

        {urls.length < MAX_CAPTURE_LINKS ? (
          <button
            type="button"
            onClick={() => setUrls((prev) => [...prev, ''])}
            className="inline-flex min-h-11 items-center gap-2 self-start rounded-lg px-1 text-[13px] font-medium text-[color:var(--brass-deep)] transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]"
          >
            <span aria-hidden className="text-[16px] leading-none">+</span>
            Add another link
            <span className="font-normal text-[color:var(--text-faint)]">({urls.length}/{MAX_CAPTURE_LINKS})</span>
          </button>
        ) : (
          <p className="px-1 text-[13px] text-[color:var(--text-faint)]">Max {MAX_CAPTURE_LINKS} links at a time.</p>
        )}
        {/* Honest "Soon" teaser (matches the landing's Telegram line) — no date promised. */}
        <p className="border-t border-dashed border-[color:var(--line-soft)] px-1 pt-2.5 text-[13px] text-[color:var(--text-faint)]">
          <span className="font-medium text-[color:var(--brass-deep)]">Coming soon:</span> share Reels to the
          Astrail Telegram bot and they&rsquo;ll land in your library automatically — no more pasting one by one.
        </p>
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
          <h2 className="font-display text-[18px] font-medium text-[color:var(--text)]">No trays yet</h2>
          <p className="max-w-[42ch] text-[14px] text-[color:var(--text-muted)]">
            A tray is a group of saved Reels &mdash; one per trip you are thinking about. Paste the
            Reels you saved and Astrail will pull out the real places, check they exist, and connect
            them into a route you can follow.
          </p>
        </div>
      ) : (
        <>
          {/* Library banner — the doorway into every saved reel. Opens the full-surface
              LibraryPanel (T1.3), which owns filter/search/browse-fan/select→organize. */}
          <button
            type="button"
            onClick={() => setLibraryOpen(true)}
            className="mb-8 flex w-full items-center justify-between gap-4 rounded-2xl border border-[color:var(--brass-deep)] bg-[color:var(--brass-wash)] px-8 py-9 text-left transition-colors hover:bg-[color:var(--surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]"
          >
            <span>
              <span className="block font-display text-[24px] font-medium leading-tight text-[color:var(--text)]">Your inspiration starts here</span>
              <span className="mt-1.5 block text-[14px] text-[color:var(--text-muted)]">Every reel you saved, in one place.</span>
            </span>
            <span aria-hidden className="text-[14px] font-medium text-[color:var(--brass-deep)]">Open</span>
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
