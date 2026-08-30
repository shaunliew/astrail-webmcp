'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'

import AgentActivityRail from './AgentActivityRail'
import ExamplePrompts from './ExamplePrompts'
import WebMcpStatus from './WebMcpStatus'
import { useOptionalWebMcpRegistry, type ActivityEntry } from './WebMcpRegistry'

/**
 * One dock, not three floating boxes.
 *
 * These three panels were each `fixed` at their own bottom offset (4 / 16 / 28), which only works
 * while every one of them is short. The rail grows to five entries, the tool list grows with the
 * catalogue, and on a phone any of them is nearly full width — so they overlapped the moment the
 * app did something interesting.
 *
 * Stacking them in a single bottom-anchored column instead means each panel sizes itself and the
 * others move out of the way, at any viewport, with no magic numbers to keep in sync.
 *
 * `items-end` keeps everything flush right; `pointer-events-none` on the column with `auto` on the
 * children means the empty space between panels never swallows a click on the map behind it.
 *
 * "Behind it" is the assumption that had to be qualified. This dock is mounted once, in the /app
 * shell, and the shell covers two kinds of screen: the trip and trails routes are a full-bleed
 * map that owns the whole viewport, and a floating dock over a canvas is exactly what the agent
 * chrome should be there — it is what OpenAI's own showcase apps do (Codex Modeling Studio's
 * ~480px non-blocking footer pill over its 3D canvas). Every other /app route is a paper DOCUMENT
 * with a scrolling content column, and a fixed dark dock over THAT is the one thing none of the
 * six showcase apps do (docs/webmcp/SHOWCASE-PATTERNS.md).
 *
 * Measured in a browser on the merged tree, at 1280x800 and 390x844, the difference is not
 * cosmetic: over the /app home the example-prompts panel alone covered the capture form's Save
 * button — `elementFromPoint` on the button's own centre returned the panel — a whole tray card,
 * and on a phone the entire "Plan a trip from your N saved reels" call to action. Screenshots in
 * docs/webmcp/evidence/. No unit test can see this: jsdom has no layout engine, no stacking
 * contexts and no paint, so the suites stayed green through all of it.
 */

/**
 * Whether the route under the dock is a full-bleed canvas rather than a document.
 *
 * One prefix covers both canvas routes deliberately: `/app/trip/<id>` (the itinerary map) and
 * `/app/trips` (the three-pane that shows the same shared fixed map through a right-hand window).
 * Everything else under /app — the home, settings — is a paper document.
 */
export function isCanvasRoute(pathname: string): boolean {
  return pathname.startsWith('/app/trip')
}

/**
 * Where the minimised choice is remembered.
 *
 * Its own key, deliberately separate from the prompts panel's dismissal: one is "I have read the
 * examples, stop showing me them" and the other is "not right now" about the whole surface.
 */
const COLLAPSED_KEY = 'astrail:webmcp:dock-collapsed'

/** Stable identity, so an absent registry does not re-run the effects below every render. */
const NO_ACTIVITY: readonly ActivityEntry[] = []

/**
 * The dock folded away: one line, and never nothing.
 *
 * This is the DOCK's control, not the rail's. It lived on the rail, which renders nothing until a
 * tool has actually run — so the state a judge arrives in, a first visit with no agent activity,
 * had the prompts panel over the map and no fold anywhere to be found. The only escape was that
 * panel's own ✕, which dismisses the examples for good. "Not right now" is a far better thing to
 * offer someone than "never show me this again", and it has to exist before the agent acts.
 *
 * Folded is never nothing. The dock is the only place this app says out loud that an agent is
 * attached to the page, so a control that could hide it completely would let someone lose the
 * affordance the whole integration exists to show. Every showcase app keeps a small persistent
 * indicator (docs/webmcp/SHOWCASE-PATTERNS.md), and this is ours.
 *
 * The count is deliberately quiet rather than self-opening. An agent following a generation calls
 * `get_trip_progress` about every twenty seconds, so expanding on each arriving entry would
 * re-cover the map three times a minute — it would undo the fold the user just asked for, which
 * is not a control, it is a control that argues back.
 *
 * It does carry the one distinction the rail already draws: a write is not a read. And it carries
 * it in the ACCESSIBLE NAME, not only in the colour of the dot, because the person who cannot see
 * the dot is exactly the person who otherwise has no way to tell the two apart.
 */
function FoldedPill({
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

export default function WebMcpDock() {
  // Lifted here because the two panels are alternatives, not companions: on a 375px screen they
  // together fill the entire viewport and bury the map the agent is supposed to be driving.
  const [toolsOpen, setToolsOpen] = useState(false)
  /**
   * Minimised, and OWNED HERE rather than in the rail, because putting the agent surface away has
   * to take the prompts panel with it. Two independent collapses would be two gestures for one
   * intent, and would leave a "minimised" dock still holding ~160px of the map.
   *
   * Starts open, and the stored value arrives in an effect. That is the right default rather than
   * a compromise: a first visitor must find the agent surface, and there is no flash to trade it
   * against — the rail renders nothing until a tool has run, and `activity` starts empty on every
   * mount, so this effect has always landed before there is anything for it to hide.
   */
  const [collapsed, setCollapsed] = useState(false)
  /** The newest entry the user had already seen when the dock was folded. Null while open. */
  const [seenThroughId, setSeenThroughId] = useState<number | null>(null)
  const latestIdRef = useRef(0)
  const overCanvas = isCanvasRoute(usePathname() ?? '/app')

  const registry = useOptionalWebMcpRegistry()
  const activity = registry?.activity ?? NO_ACTIVITY
  const latestId = activity.length ? activity[activity.length - 1].id : 0

  /**
   * Whether there is anything under the fold worth folding.
   *
   * Over a canvas the prompts panel is the thing, and it is there from the first paint — which is
   * the whole reason this moved off the rail. On a document route 99c1384 already dropped that
   * panel, so the rail is all there is, and a fold control over a scrolling content column that
   * folds away nothing is exactly the noise that fix existed to remove. Without an agent in the
   * browser neither panel renders at all.
   *
   * Imprecise in one direction, deliberately: a user who has permanently dismissed the prompts
   * panel still sees the control over a canvas with no activity. Pressing it then is not a dead
   * control — it pre-commits the dock to folded, so the first thing the agent does arrives as a
   * count rather than as a panel over the map.
   */
  const foldable = (registry?.supported ?? false) && (overCanvas || activity.length > 0)

  useEffect(() => {
    latestIdRef.current = latestId
  }, [latestId])

  useEffect(() => {
    // Read through the ref and depend on the FOLD alone. Depending on `activity` would re-arm the
    // marker every time an entry arrived, which is indistinguishable from never counting one.
    setSeenThroughId(collapsed ? latestIdRef.current : null)
  }, [collapsed])

  useEffect(() => {
    // Private windows throw on the read. Remembering a preference is not worth a blank corner,
    // and the direction to fail in is the discoverable one.
    try {
      if (window.localStorage.getItem(COLLAPSED_KEY) === '1') setCollapsed(true)
    } catch { /* stays open, which is the state a first visitor gets anyway */ }
  }, [])

  const changeCollapsed = useCallback((next: boolean) => {
    setCollapsed(next)
    // Minimised means the corner goes quiet, with no exceptions to remember: the tool inspector
    // is up to 60dvh of opaque black and would otherwise sit there contradicting the word.
    if (next) setToolsOpen(false)
    try {
      if (next) window.localStorage.setItem(COLLAPSED_KEY, '1')
      else window.localStorage.removeItem(COLLAPSED_KEY)
    } catch { /* the collapse still holds for this session, it just will not outlive it */ }
  }, [])

  // Ids are monotonic in the registry, so "arrived since the fold" is exact rather than a
  // timestamp comparison a clock change could get wrong. Cleared entries need no special case:
  // a clear is only reachable while unfolded, and the marker is taken at or above its watermark.
  const unread = seenThroughId === null ? NO_ACTIVITY : activity.filter((e) => e.id > seenThroughId)

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col items-end gap-2 p-4
                 sm:inset-x-auto sm:right-0"
      style={{ maxHeight: '100dvh' }}
    >
      {/* Order matters: the chip is last so it stays pinned to the bottom-right corner and never
          moves when something above it appears. A control that jumps is a control you cannot hit. */}
      {/* Dropped on a document route, not shrunk. It is the tallest panel here (~280px of opaque
          black) and it is the one the page can replace: the /app home now leads with an in-content
          agent band carrying the same "here is what to say" job and one prompt that runs as
          written, laid out WITH the page instead of over it. Two prompt blocks with two different
          texts is worse than either alone. Over a canvas there is no such band, so it stays. */}
      {/* Minimising is only ever allowed to REMOVE chrome — there is no state reachable through
          that control in which more is on screen than before it — so it cannot walk back the
          route split above, and expanding on a document route brings back exactly what was
          there: the rail, capped, and no prompts panel. */}
      {overCanvas && !toolsOpen && !collapsed && <ExamplePrompts />}
      {!collapsed && <AgentActivityRail compact={!overCanvas} />}
      {foldable &&
        (collapsed ? (
          /* Folded, the rail is unmounted and the live region it carries goes with it, so the
             count is the only thing left that can tell a screen reader an agent just acted. */
          <div aria-live="polite" aria-label="Agent activity" className="pointer-events-none">
            <FoldedPill
              unread={unread.length}
              hasChange={unread.some((e) => e.changes)}
              onExpand={() => changeCollapsed(false)}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => changeCollapsed(true)}
            aria-expanded
            aria-label="Minimise agent activity"
            className="pointer-events-auto rounded-full border border-[#C9974E]/40 bg-black/60 px-3 py-1
                       text-[10px] uppercase tracking-wider text-[#E8D5B0] backdrop-blur transition hover:border-[#C9974E]"
          >
            Minimise
          </button>
        ))}
      <WebMcpStatus open={toolsOpen} onOpenChange={setToolsOpen} />
    </div>
  )
}
