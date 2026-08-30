'use client'

import { useCallback, useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'

import AgentActivityRail from './AgentActivityRail'
import ExamplePrompts from './ExamplePrompts'
import WebMcpStatus from './WebMcpStatus'

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
  const overCanvas = isCanvasRoute(usePathname() ?? '/app')

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
      <AgentActivityRail compact={!overCanvas} collapsed={collapsed} onCollapsedChange={changeCollapsed} />
      <WebMcpStatus open={toolsOpen} onOpenChange={setToolsOpen} />
    </div>
  )
}
