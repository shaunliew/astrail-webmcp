'use client'

import { useEffect, useRef, useState } from 'react'
import { useOptionalWebMcpRegistry, type ActivityEntry } from './WebMcpRegistry'

/**
 * The record of what the agent did, kept for as long as the session lasts.
 *
 * This is the difference between an agent operating your app and an agent operating it *with*
 * you. Every tool call surfaces here — reads included, because a read the user never sees is a
 * read they could not have consented to. It is simultaneously the UX affordance and the audit log.
 *
 * It used to drop each entry after eight seconds, which made it neither: a user who noticed
 * something wrong and looked up to check it found the evidence already gone, and five reads in a
 * row erased the edit before them. The record now persists and the RAIL is what stays small —
 * collapsed to the newest entry, with everything else one click away. Nothing is discarded to buy
 * that space.
 *
 * Entries are written in the app's vocabulary ("MOVED  7 · Senso-ji → Day 3"), never the tool's.
 *
 * There is deliberately no undo button. Astrail has no inverse to offer: `remove_place` says so
 * in its own approval card ("This cannot be undone"), and `move_place` cannot restore a stop
 * whose `sort_order` was null, which is a legal row. The honest move is to say a change cannot be
 * taken back, not to render a control that fails when pressed.
 */

/** One receipt. The card the rail has always drawn, plus the two things it never said. */
function Entry({ entry }: { entry: ActivityEntry }) {
  return (
    <div className="rounded-lg border border-[#C9974E]/40 bg-black/80 px-3 py-2 text-xs backdrop-blur">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={[
            'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
            entry.status === 'running' ? 'animate-pulse bg-[#C9974E]' : entry.status === 'failed' ? 'bg-red-400' : 'bg-[#C9974E]/60',
          ].join(' ')}
        />
        <span className="text-[10px] uppercase tracking-wider text-[#E8D5B0]">{entry.label}</span>
        {/* "By whom", in the same two words the evidence chips already use. Right-aligned so a
            column of entries reads down as one who-column rather than a ragged second label. */}
        {/* `title`, not `aria-label`: a bare span has the `generic` role, which prohibits an
            author-supplied name, so an aria-label here would be silently dropped by AT and read
            as covered. The visible word is the accessible name, and it is the same word a
            sighted user gets; the tooltip only spells out the sentence for a pointer. */}
        <span
          title={`${entry.actor} decided this`}
          className={[
            'ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px]',
            entry.actor === 'You' ? 'bg-[#C9974E]/20 text-[#E8D5B0]' : 'bg-white/10 text-white/60',
          ].join(' ')}
        >
          {entry.actor}
        </span>
      </div>
      {entry.detail && (
        /* Tool output can carry Reel-caption text, so it renders as text and is clipped. */
        <p className="mt-0.5 line-clamp-2 pl-3.5 text-white/70">{entry.detail}</p>
      )}
      {/* Only once it has actually landed — a running or failed call has nothing to take back yet.
          True of every write the app has, so it never has to guess which ones qualify. */}
      {entry.changes && entry.status === 'done' && (
        <p className="mt-1 pl-3.5 text-[10px] text-white/45">Astrail can&apos;t undo this</p>
      )}
    </div>
  )
}

/**
 * The rail put away: one line, and never nothing.
 *
 * The dock is the only place this app says out loud that an agent is attached to the page, so a
 * control that could hide it completely would let someone lose the affordance the whole
 * integration exists to show. Every showcase app keeps a small persistent indicator
 * (docs/webmcp/SHOWCASE-PATTERNS.md), and this is ours: the surface is still here, and here is
 * how much happened while you were not looking.
 *
 * The count is deliberately quiet rather than self-opening. An agent following a generation calls
 * `get_trip_progress` about every twenty seconds, so expanding on each arriving entry would
 * re-cover the map three times a minute — it would undo the collapse the user just asked for,
 * which is not a control, it is a control that argues back.
 *
 * It does carry the one distinction the rail already draws: a write is not a read. And it carries
 * it in the ACCESSIBLE NAME, not only in the colour of the dot, because the person who cannot see
 * the dot is exactly the person who otherwise has no way to tell the two apart.
 */
function CollapsedPill({
  unread,
  hasChange,
  onExpand,
}: {
  unread: number
  hasChange: boolean
  onExpand: () => void
}) {
  const label =
    unread === 0
      ? 'Show agent activity'
      : hasChange
        ? `Show agent activity, ${unread} new, including a change`
        : `Show agent activity, ${unread} new`

  return (
    <button
      type="button"
      onClick={onExpand}
      aria-expanded={false}
      aria-label={label}
      className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-[#C9974E]/40 bg-black/70 px-3 py-1
                 text-[10px] uppercase tracking-wider text-[#E8D5B0] backdrop-blur transition hover:border-[#C9974E]"
    >
      <span
        aria-hidden
        className={[
          'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
          hasChange ? 'bg-[#C9974E]' : unread > 0 ? 'bg-white/50' : 'bg-[#C9974E]/40',
        ].join(' ')}
      />
      Agent{unread > 0 ? ` · ${unread}` : ''}
    </button>
  )
}

export default function AgentActivityRail({
  compact = false,
  collapsed = false,
  onCollapsedChange,
}: {
  compact?: boolean
  /**
   * Owned by the dock, not by the rail, because minimising has to take the prompts panel with it.
   * One gesture, one state, and the dock is the only component that can see both panels.
   */
  collapsed?: boolean
  /**
   * Absent when nothing can act on a collapse — a standalone rail, or a test. The rail then draws
   * no minimise control and ignores `collapsed` outright, for the same reason it has never had an
   * undo button: a control the app cannot honour must not exist, and a pill with no handler
   * behind it would be a one-way door onto the record.
   */
  onCollapsedChange?: (collapsed: boolean) => void
}) {
  const registry = useOptionalWebMcpRegistry()
  const [showEarlier, setShowEarlier] = useState(false)
  /** The newest entry the user had already seen when the rail was put away. Null while open. */
  const [seenThroughId, setSeenThroughId] = useState<number | null>(null)
  /**
   * The newest entry the user has dismissed. Everything at or below it is gone from the rail.
   *
   * A WATERMARK, not a delete: the registry's list is append-only and stays that way. The record
   * is an audit surface, and an audit surface the audited thing can shorten is not one — a tool
   * that could reach `setActivity` could erase itself. Nothing recovers a cleared entry from the
   * UI, so from the user's side this is a clear and not a filing cabinet; the store simply is not
   * the place to enforce that.
   */
  const [cleared, setCleared] = useState<{ throughId: number; spared: readonly number[] }>({
    throughId: 0,
    spared: [],
  })
  const latestIdRef = useRef(0)

  const collapsible = onCollapsedChange !== undefined
  const isCollapsed = collapsible && collapsed

  /**
   * What the rail is showing: everything since the last clear, plus anything still in flight.
   *
   * The exception is the whole point. A clear says "I have read these and they are done", which
   * is a thing you cannot have decided about a call that has not come back yet — and a user who
   * clears mid-generation must not be left believing the run died.
   *
   * Spared by ID rather than by live status, so the call survives to its OUTCOME. Sparing the
   * status alone would make the entry vanish the instant it landed, which on a generation means
   * the rail flickers an entry into view and out again every twenty seconds — worse than either
   * keeping it or dropping it. The next clear takes it, because by then the user has read it.
   *
   * Note what this covers and what it does not: an in-flight tool CALL, not the generation behind
   * it. Between two polls of a live run there is no running entry at all, so a clear landing in
   * that window empties the rail until the next poll writes to it.
   */
  const activity = registry?.activity
  const visible = activity?.filter((e) => e.id > cleared.throughId || cleared.spared.includes(e.id))
  const latestVisibleId = visible?.length ? visible[visible.length - 1].id : 0

  useEffect(() => {
    latestIdRef.current = latestVisibleId
  }, [latestVisibleId])

  useEffect(() => {
    // Read through the ref and depend on the COLLAPSE alone. Depending on `activity` would re-arm
    // the marker every time an entry arrived, which is indistinguishable from never counting one.
    setSeenThroughId(isCollapsed ? latestIdRef.current : null)
  }, [isCollapsed])

  if (!registry || !visible?.length) return null

  if (isCollapsed) {
    // Ids come from a monotonic counter in the registry, so "arrived since" is exact rather than
    // a timestamp comparison that a clock change could get wrong.
    const unread = seenThroughId === null ? [] : visible.filter((e) => e.id > seenThroughId)
    return (
      <div
        aria-live="polite"
        aria-label="Agent activity"
        className="pointer-events-none flex w-[min(22rem,100%)] justify-end"
      >
        <CollapsedPill
          unread={unread.length}
          hasChange={unread.some((e) => e.changes)}
          onExpand={() => onCollapsedChange?.(false)}
        />
      </div>
    )
  }

  const latest = visible[visible.length - 1]
  const earlier = visible.slice(0, -1)

  return (
    <div
      aria-live="polite"
      aria-label="Agent activity"
      className="pointer-events-none w-[min(22rem,100%)] space-y-1.5"
    >
      {showEarlier && earlier.length > 0 && (
        /* `aria-live="off"` inside a polite region: expanding is the user reading back on their
           own initiative, and reciting the whole history at them is not that. Capped and
           scrollable so a long session cannot bury the map the agent is supposed to be driving.
           The cap is route-aware for the same reason it exists at all: 45dvh of read-back is
           peripheral over a map that owns the viewport, and three quarters of the screen over a
           document page. `compact` trades the taller window for a shorter one — the list still
           holds every entry and still scrolls, so nothing is discarded either way. */
        <div
          aria-live="off"
          aria-label="Earlier agent activity"
          className={[
            'pointer-events-auto space-y-1.5 overflow-y-auto overscroll-contain',
            compact ? 'max-h-36' : 'max-h-[45dvh]',
          ].join(' ')}
        >
          {earlier.map((e) => (
            <Entry key={e.id} entry={e} />
          ))}
        </div>
      )}

      <Entry entry={latest} />

      {/* Last, so it keeps its place: the dock is bottom-anchored and grows upward, which makes
          the bottom-most control the only one that never moves under the user's finger. Both
          controls share the row for that reason — a second row would move the first. */}
      {(earlier.length > 0 || collapsible) && (
        <div className="flex items-center justify-end gap-1.5">
          {earlier.length > 0 && (
            <button
              type="button"
              onClick={() => setShowEarlier((open) => !open)}
              aria-expanded={showEarlier}
              aria-label={showEarlier ? 'Hide earlier agent activity' : 'Show earlier agent activity'}
              className="pointer-events-auto rounded-full border border-[#C9974E]/40 bg-black/60 px-3 py-1
                         text-[10px] uppercase tracking-wider text-[#E8D5B0] backdrop-blur transition hover:border-[#C9974E]"
            >
              {showEarlier ? 'Hide earlier' : `${earlier.length} earlier`}
            </button>
          )}
          {collapsible && (
            <button
              type="button"
              onClick={() =>
                setCleared({
                  throughId: latest.id,
                  spared: visible.filter((e) => e.status === 'running').map((e) => e.id),
                })
              }
              aria-label="Clear agent activity"
              className="pointer-events-auto rounded-full border border-white/20 bg-black/60 px-3 py-1
                         text-[10px] uppercase tracking-wider text-white/70 backdrop-blur transition hover:border-white/50"
            >
              Clear
            </button>
          )}
          {collapsible && (
            <button
              type="button"
              onClick={() => onCollapsedChange?.(true)}
              aria-expanded
              aria-label="Minimise agent activity"
              className="pointer-events-auto rounded-full border border-[#C9974E]/40 bg-black/60 px-3 py-1
                         text-[10px] uppercase tracking-wider text-[#E8D5B0] backdrop-blur transition hover:border-[#C9974E]"
            >
              Minimise
            </button>
          )}
        </div>
      )}
    </div>
  )
}
