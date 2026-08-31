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
import { useOptionalWebMcpRegistry } from '@/components/webmcp/WebMcpRegistry'
import AgentBand from './AgentBand'
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

/* The three Reels in the starter prompt are the frozen Case 1 demo set from
   docs/evals/japan-beta-input-template.md — the same URLs backend/evals/fixtures/japan_demo_reels.json
   holds real captured Apify captions for, that expected_places.json resolves to real Tokyo
   coordinates, and that scripts/smoke_generate.py plans with. Nothing here is invented, so the
   prompt cannot send a judge to a dead link. The fourth reel of that set (the Doraemon
   exhibition) is left out on purpose: its own caption closes the exhibition on 30 September
   2026. The dates below roll with the clock, so that reel would be plannable one week and a
   dead end the next — a place that ages out has no business in a prompt that never does. */
const STARTER_REEL_URLS = [
  'https://www.instagram.com/reel/DYGH3jFBZHz/',
  'https://www.instagram.com/reel/DYM_I5IvLSv/',
  'https://www.instagram.com/reel/DXwcVVliX3B/',
] as const

/* `plan_trip_from_reels` REQUIRES start_date and end_date as YYYY-MM-DD, so the prompt states
   both literally rather than saying "next month" and hoping the agent picks. Ten days out is the
   only window that serves both readers of this prompt. NEAR enough that the forecast stage still
   has the days: a real run on 2026-08-28 for dates 14 days out came back
   "warning/weather: No forecast available this far ahead", so at the 77 days the old hardcoded
   pair had drifted to, the seeded demo trip — the one a judge is most likely to run — arrived
   with no weather on any day, visibly thinner than the product can do. FAR enough to read as a
   trip somebody would genuinely be planning rather than leaving for tomorrow. Five nights is the
   length we tested. Derived from the clock, never frozen: a frozen pair reads as stale within
   weeks and, read a year on, plans a trip into a date that has already gone. */
const STARTER_LEAD_DAYS = 10
const STARTER_TRIP_NIGHTS = 5
const MS_PER_DAY = 86_400_000

const toIsoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** The starter prompt's `YYYY-MM-DD` date pair for a given clock.
 *
 *  Anchored on `now`'s UTC calendar day and advanced in whole UTC days, so the printed pair is
 *  the same everywhere and never lands off by one: reading LOCAL date parts and serialising them
 *  back through `toISOString()` shifts the day either side of midnight — in GMT+8 a locally-built
 *  midnight is still yesterday in UTC. Pure and exported so the window can be checked at many
 *  clocks without rendering the screen. */
export function starterTripDates(now: Date): { start: string; end: string } {
  const startMs =
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + STARTER_LEAD_DAYS * MS_PER_DAY
  return { start: toIsoDay(startMs), end: toIsoDay(startMs + STARTER_TRIP_NIGHTS * MS_PER_DAY) }
}

/* Runnable as written. Pasted into ChatGPT with this page open it satisfies every required
   argument of `plan_trip_from_reels` with no edits: 1-5 reel links (saving them first is
   optional — the tool takes raw pasted URLs) plus both ISO dates. */
function buildStarterPrompt(now: Date): string {
  const { start, end } = starterTripDates(now)
  return `Plan me a Tokyo trip from these Instagram Reels:
${STARTER_REEL_URLS.join('\n')}
Start date ${start}, end date ${end}. Mid-range budget, walkable days.`
}

/* The band's prompt, for an account that already HAS reels — so it names no destination and
   pastes no links: the agent reads the user's own library with `list_saved_reels` and hands
   those URLs to `plan_trip_from_reels`, which spells that recovery out in its own description
   ("Call list_saved_reels or ask the user for links"). Both ISO dates are still stated
   literally, for the same reason the starter prompt states them: the tool refuses without them.

   Takes the pair as ARGUMENTS rather than reading the dates itself, which is what let the
   screen swap a frozen pair for `starterTripDates` without touching this function: the demo
   window keeps exactly one definition here, so this prompt cannot drift out of step with the
   starter one. It also keeps date policy out of the band entirely: AgentBand is handed a
   finished string, so nothing about it is clock-dependent and its tests need no fake timers. */
function buildAgentBandPrompt(start: string, end: string): string {
  return `Look at my saved reels in Astrail and plan me a trip from them. Start date ${start}, end date ${end}. Mid-range budget, walkable days.`
}

export default function TraysScreen({
  cards,
  cardsStatus = 'ready',
  onCapture,
  onOrganize,
  onCreateTrail,
  revealLibrary = 0,
}: {
  cards: SavedReelCard[]
  // Parent's saved-reel fetch state; forwarded to TrayDetail so an in-flight/failed cards
  // load doesn't read as an empty tray. Tray COUNTS come from membership (below), not cards.
  cardsStatus?: 'loading' | 'error' | 'ready'
  onCapture: (url: string) => Promise<void>
  onOrganize: (ids: string[]) => Promise<void>
  onCreateTrail: (trayCards: SavedReelCard[]) => void
  /**
   * How many times the flow above has asked for the Library — the screen behind "Open" — to be
   * put on screen, because an agent saved reels into it. A COUNT, not a flag: closing the
   * Library and saving again is one ask each, and a boolean could only ever say the first.
   *
   * Optional, and 0 without a parent that asks: this screen is complete on its own.
   */
  revealLibrary?: number
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
  // Idle until the user presses Copy; rendered only when it has something to report, so the
  // starter block does not reserve a line of empty status and shift the layout on mount.
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const activeRef = useRef(true)
  // Monotonic refresh id: overlapping refreshes (e.g. two adds from separate reel-card
  // instances, one opened after Escaping the other) can resolve out of order. Only the newest
  // refresh may write state, so a stale read can never overwrite newer membership (Codex race).
  const refreshGenRef = useRef(0)
  // OPTIONAL on purpose: TraysScreen renders under the /app shell's provider in the product, but
  // it must not crash anywhere the agent layer is absent — the same trade RegisterTools makes.
  // No provider reads as "no agent", which is the safe side of this fork.
  const registry = useOptionalWebMcpRegistry()

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

  /**
   * The agent's save, put on screen.
   *
   * `save_reels` awaits a reveal so it cannot report a save the user's screen has not caught up
   * with, and the screen it means is the Library: the home shows a greeting, a capture form and
   * the trays, so a save that only bumps a count leaves the reels themselves behind a button the
   * user has to find. This is that button, pressed for them.
   *
   * `revealedAt` is what makes an ask BELONG to this screen. The flow above unmounts this
   * component for every other phase it has, so a count raised while the user was mid-organize
   * would otherwise be applied by the mount that happens when they come back — a Library opening
   * minutes later with nothing they did to explain it. A count this component was born with is
   * therefore already spent.
   *
   * ...and an ask is spent whether or not it is acted on: an open tray (or a half-filled create
   * dialog) is somewhere the user chose to be, and the same rule the flow applies to its own
   * phases applies to these. Consuming it there is the point — deferring would spring the
   * Library open the moment they closed the tray.
   */
  const revealedAt = useRef(revealLibrary)
  useEffect(() => {
    if (revealLibrary === revealedAt.current) return
    revealedAt.current = revealLibrary
    // Already there — and possibly mid-selection, which switching the mode would disturb.
    if (libraryOpen || openTrayId !== null || createOpen) return
    // Browse, always: 'select' belongs to "Plan a trip", where the user has already said what
    // they want. An agent's save has said nothing of the sort.
    setLibraryMode('browse')
    setLibraryOpen(true)
  }, [revealLibrary, libraryOpen, openTrayId, createOpen])

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

  /* CONFIRMED empty — stricter than `isEmpty` above, and deliberately a separate derivation.
     `isEmpty` only chooses which flavour of the manual layout to show, so an unread saved-reel
     fetch there costs a wrong sentence. This one decides whether to hand the primary position to
     an agent and fold the manual form away, and a wrong "you have nothing" there sends a judge
     down a path built for a library we never actually read. `loading`/`error` cover the
     collections + membership fetch this component runs; `cardsStatus` covers the saved-reel fetch
     it does NOT run and therefore cannot infer from `cards.length` — an in-flight load, a failed
     load and a genuinely empty library all arrive here as `cards === []`. */
  const confirmedEmpty = isEmpty && cardsStatus === 'ready'

  /* The layout is the prompt. On an empty account the screen said "paste a Reel link" and nothing
     else, so that is what the agent read off the page and repeated back to a user who had no
     links to paste. The agent gets the primary position only where there IS an agent: without
     `document.modelContext` this fork would hide the one control that works and leave a dead end. */
  const agentFirst = confirmedEmpty && registry?.supported === true

  /* The same finding, one screen later. On a home that HAS content the agent was still reading
     a manual library off the page — asked "what can I do here?" it described "Trails, New trail
     and Settings", strings that exist only in Sidebar.tsx and in no tool description anywhere.
     So the band takes the top here too.

     Gated on `supported` for the same reason `agentFirst` is: agent copy in a browser with no
     agent tells a judge in Safari to talk to nobody. Mutually exclusive with `agentFirst` —
     two agent blocks with two Copy buttons and two different prompts is worse than either
     alone, and the empty case already has an owner. Unlike `agentFirst` this fork HIDES
     NOTHING: the capture form, the library and the trays all stay exactly where they were, so
     a confirmed count is a nicety here and not the load-bearing decision it is up there.

     `homeShapeKnown` is not politeness. Painted on `!agentFirst` alone, the band appears on the
     FIRST frame of an EMPTY account — where `loading` is still true, so `confirmedEmpty` is not
     yet true either — and is then torn out and replaced by the invitation a beat later. A flash
     in the one position on the page that must not move, and a genuinely detached button in
     between (a click landing in that window does nothing at all, which is how the existing
     copy-prompt tests caught it). Reels already in hand settle the question with no wait; only
     an account that looks empty has to hear back from the collections read first. */
  const homeShapeKnown = cards.length > 0 || !loading
  const agentBand = registry?.supported === true && !confirmedEmpty && homeShapeKnown

  /* Read once per mount rather than on every render, so the text the Copy button writes is
     always byte-for-byte the text on screen — a re-render that straddled UTC midnight would
     otherwise hand the user a prompt a day off from the one they had just read. BOTH prompts
     come off this single reading: the band and the invitation never render together, but two
     separate `new Date()` calls would still be two windows that can disagree. */
  const { starterPrompt, agentBandPrompt } = useMemo(() => {
    const now = new Date()
    const { start, end } = starterTripDates(now)
    return { starterPrompt: buildStarterPrompt(now), agentBandPrompt: buildAgentBandPrompt(start, end) }
  }, [])

  async function copyStarterPrompt() {
    try {
      await navigator.clipboard.writeText(starterPrompt)
      if (activeRef.current) setCopyState('copied')
    } catch {
      // Clipboard access is permission-gated and absent entirely over plain http. The prompt is
      // rendered as selectable text for exactly this case — say so rather than fail silently.
      if (activeRef.current) setCopyState('failed')
    }
  }

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

  /* The capture form and its status line, built once and rendered in ONE of two positions: at
     the top of the page as it always was, or folded into a closed <details> under the agent
     invitation. Identical markup either way — a demoted form that behaved differently from the
     one every other account sees would be a second capture flow to keep working. */
  const capturePanel = (
    <>
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
    </>
  )

  /* The agent invitation — the primary position on a CONFIRMED-empty account in a browser that
     has an agent. Compact on purpose: the <details> below it has to stay above the fold on a
     laptop, or a judge without WebMCP concludes there is no manual route at all. */
  const agentInvitation = (
    <section className="mb-4 rounded-2xl border border-[color:var(--brass-deep)] bg-[color:var(--brass-wash)] p-5">
      <h2 className="font-display text-[18px] font-medium text-[color:var(--text)]">
        No Reels of your own? Start here.
      </h2>
      <p className="mt-1.5 max-w-[62ch] text-[14px] text-[color:var(--text-muted)]">
        Astrail is built to be driven by an AI agent. With this page open, paste the prompt below
        into ChatGPT &mdash; it already carries three real Tokyo Reels, so you do not need any of
        your own.
      </p>
      {/* Selectable text, not an input: it is the fallback when the clipboard is unavailable,
          and it must never look like one more field waiting to be filled in. */}
      <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-lg border border-[color:var(--line-soft)] bg-[color:var(--surface-1)] p-3 font-mono text-[12px] leading-[1.6] text-[color:var(--text)]">
        {starterPrompt}
      </pre>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void copyStarterPrompt()} className={BTN_PRIMARY}>
          Copy prompt
        </button>
        {copyState !== 'idle' ? (
          <p role="status" className="text-[13px] text-[color:var(--text-muted)]">
            {copyState === 'copied'
              ? 'Copied. Paste it into ChatGPT with this page open.'
              : 'Copy did not work in this browser — select the prompt above and copy it yourself.'}
          </p>
        ) : null}
      </div>
      {/* "before anything runs" was an absolute this flow does not honour: an agent handed the
          starter prompt may call `save_reels` on the way to planning, and that tool raises no
          approval card while starting a paid extraction. The generation IS gated —
          `plan_trip_from_reels` awaits confirm() before it creates the trip — so the sentence
          names that step and claims nothing wider. It still says nothing about SPEND, unlike the
          band on a populated home: this screen is shown to accounts whose trip entitlement may
          already be gone, and promising them an allowance to spend is its own false claim. */}
      <p className="mt-3 text-[13px] text-[color:var(--text-faint)]">
        Astrail will ask you to approve the plan on this page before it starts building the trip.
      </p>
    </section>
  )

  return (
    <>
    <div className="mx-auto flex w-full max-w-5xl flex-col">
      {/* ABOVE the greeting, deliberately. The agent reads this page top-down and repeats back
          whatever it meets first; leaving a 36px display name in that position is how a travel
          planner ends up describing its own nav rail. The count is passed only when the parent
          has actually READ the library — `cards` is empty while that fetch is in flight, while
          it is failing, and when there is genuinely nothing, and the band prints no number it
          cannot stand behind. */}
      {agentBand ? (
        <AgentBand
          savedCount={cardsStatus === 'ready' && cards.length > 0 ? cards.length : null}
          prompt={agentBandPrompt}
        />
      ) : null}

      <header className="mb-10">
        <p className="text-[14px] text-[color:var(--text-muted)]">Welcome back,</p>
        <span
          className="mt-1.5 block font-display text-[36px] font-medium leading-[1.1] tracking-[-0.015em] text-[color:var(--text)]"
          style={{ fontVariationSettings: "'SOFT' 36, 'WONK' 0, 'opsz' 36" }}
        >
          {name}
        </span>
      </header>

      {agentFirst ? agentInvitation : null}

      {/* Demoted, never deleted. Closed by default so the agent prompt leads, and kept directly
          under the invitation so the summary stays above the fold: a judge whose browser has no
          agent has to be able to SEE that pasting links yourself is still a route. */}
      {agentFirst ? (
        <details className="mb-6">
          {/* Default `list-item` display, NOT inline-flex: any other display drops the native
              disclosure triangle, and without it the summary reads as a link that goes somewhere
              else rather than a section that opens here. `list-inside` keeps the marker inside
              the padding box so it lines up with the content above. */}
          <summary className="w-fit list-inside rounded-lg px-1 py-2.5 text-[13px] font-medium text-[color:var(--brass-deep)] transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]">
            Prefer to paste Reel links here?
          </summary>
          <div className="mt-3">{capturePanel}</div>
        </details>
      ) : (
        capturePanel
      )}
      {error ? (
        <p role="alert" className="mb-6 rounded-lg border border-dashed border-[color:var(--line-soft)] bg-[color:var(--surface-2)] p-3 text-[13px] text-[color:var(--text-muted)]">
          {error}
        </p>
      ) : null}

      {/* `agentFirst` replaces this whole block: the invitation IS the empty state there, and
          stacking "No trays yet" under it would push the details summary below the fold to
          re-explain an absence the user is already being given a way out of. */}
      {agentFirst ? null : isEmpty ? (
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
          {/* Library row — the doorway into every saved reel. Opens the full-surface
              LibraryPanel (T1.3), which owns filter/search/browse-fan/select→organize.

              DEMOTED, not removed: this was a 24px display heading in a brass box `px-8 py-9`
              tall, which made a filing cabinet the loudest thing on the page — and the loudest
              thing on the page is what the agent says back when you ask what you can do here.
              It now reads at the SAME rank as the "Your trays" header below it: a row you scan
              past on the way to the grid. Every word, the click target and the destination are
              unchanged, so nothing moved out of reach and no test of the library flow moved
              with it. Ungated by `supported` on purpose — this is a hierarchy change, not agent
              copy, and a browser with no agent must not get a second, divergent layout. */}
          <button
            type="button"
            onClick={() => setLibraryOpen(true)}
            className="mb-6 flex w-full flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg px-1 py-2 text-left transition-colors hover:bg-[color:var(--surface-2)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--brass-deep)]"
          >
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5">
              <span className="font-display text-[18px] font-medium text-[color:var(--text)]">Your inspiration starts here</span>
              <span className="text-[13px] text-[color:var(--text-muted)]">Every reel you saved, in one place.</span>
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
