'use client'

import { useState } from 'react'

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
 */
export default function WebMcpDock() {
  // Lifted here because the two panels are alternatives, not companions: on a 375px screen they
  // together fill the entire viewport and bury the map the agent is supposed to be driving.
  const [toolsOpen, setToolsOpen] = useState(false)

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col items-end gap-2 p-4
                 sm:inset-x-auto sm:right-0"
      style={{ maxHeight: '100dvh' }}
    >
      {/* Order matters: the chip is last so it stays pinned to the bottom-right corner and never
          moves when something above it appears. A control that jumps is a control you cannot hit. */}
      {!toolsOpen && <ExamplePrompts />}
      <AgentActivityRail />
      <WebMcpStatus open={toolsOpen} onOpenChange={setToolsOpen} />
    </div>
  )
}
