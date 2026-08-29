'use client'

import { useState } from 'react'
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

export default function AgentActivityRail() {
  const registry = useOptionalWebMcpRegistry()
  const [showEarlier, setShowEarlier] = useState(false)

  if (!registry) return null
  const { activity } = registry
  if (activity.length === 0) return null

  const latest = activity[activity.length - 1]
  const earlier = activity.slice(0, -1)

  return (
    <div
      aria-live="polite"
      aria-label="Agent activity"
      className="pointer-events-none w-[min(22rem,100%)] space-y-1.5"
    >
      {showEarlier && earlier.length > 0 && (
        /* `aria-live="off"` inside a polite region: expanding is the user reading back on their
           own initiative, and reciting the whole history at them is not that. Capped and
           scrollable so a long session cannot bury the map the agent is supposed to be driving. */
        <div
          aria-live="off"
          className="pointer-events-auto max-h-[45dvh] space-y-1.5 overflow-y-auto overscroll-contain"
        >
          {earlier.map((e) => (
            <Entry key={e.id} entry={e} />
          ))}
        </div>
      )}

      <Entry entry={latest} />

      {/* Last, so it keeps its place: the dock is bottom-anchored and grows upward, which makes
          the bottom-most control the only one that never moves under the user's finger. */}
      {earlier.length > 0 && (
        <button
          type="button"
          onClick={() => setShowEarlier((open) => !open)}
          aria-expanded={showEarlier}
          aria-label={showEarlier ? 'Hide earlier agent activity' : 'Show earlier agent activity'}
          className="pointer-events-auto ml-auto block rounded-full border border-[#C9974E]/40 bg-black/60 px-3 py-1
                     text-[10px] uppercase tracking-wider text-[#E8D5B0] backdrop-blur transition hover:border-[#C9974E]"
        >
          {showEarlier ? 'Hide earlier' : `${earlier.length} earlier`}
        </button>
      )}
    </div>
  )
}
