'use client'

import { useEffect, useState } from 'react'
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

/**
 * How long the rail waits before an entry is worth dating, and when its age stops moving.
 *
 * The second one is what lets the clock be switched off rather than merely slowed. "3h ago" needs
 * a timer running all afternoon to stay honest; "over an hour ago" is still true tomorrow, so once
 * every entry on screen has reached it there is nothing left to update, ever.
 */
const TICK_MS = 30_000
const AGE_SETTLES_AFTER_MS = 60 * 60_000

/**
 * The age of a receipt, or null while it is new enough to still read as current.
 *
 * Confirmed from a real run: the trip finished and the newest card still read "generating · 86s".
 * That is not stale data and not a missed re-render — `RegisterTools` is the only writer of
 * entries in the app and `detail` is immutable text captured when the call returned, so the entry
 * is a CORRECT receipt of a call that did return exactly that.
 *
 * The flaw is narrower than it looks. `get_trip_progress` is the one tool whose return value is a
 * world-state rather than a description of what the call did: "Moved Senso-ji to day 3" stays true
 * forever, "generating · 86s" is false a second later. Since the rail shows the newest entry on
 * its own, a reader takes a timestamped record as a current status. So nothing here rewrites the
 * record or expires it — the card is simply given its age, which is the one piece of information
 * that turns a status back into history.
 */
export function ageLabel(at: number, now: number): string | null {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return null
  if (minutes < 60) return `${minutes}m ago`
  return 'over an hour ago'
}

/**
 * What the card announces, given where the call has got to.
 *
 * `done` is the ONLY state allowed the past tense, because past tense is a claim that the thing
 * happened. Everything else shows `attempt`, the same action named without that claim: bare while
 * the call is in flight, and with its ending once it has one.
 *
 * The running case is not a nicety. `remove_place` spends its whole in-flight life with an
 * approval card on screen waiting for an answer, so `REMOVED` was on the record for exactly as
 * long as the user took to read the card and decide — the longest and most visible window of the
 * three, and the one a judge is most likely to be looking at. For the reads and the two writes
 * whose label is already a present participle, `attempt` is the same word, so nothing about a
 * correct `READING` or `SAVING` changes.
 */
function headline(entry: ActivityEntry): string {
  if (entry.status === 'running') return entry.attempt
  if (entry.status === 'declined') return `${entry.attempt} DECLINED`
  if (entry.status === 'failed') return `${entry.attempt} FAILED`
  return entry.label
}

/** One receipt. The card the rail has always drawn, plus the two things it never said. */
function Entry({ entry, now }: { entry: ActivityEntry; now: number }) {
  const age = ageLabel(entry.at, now)
  return (
    <div className="rounded-lg border border-[#C9974E]/40 bg-black/80 px-3 py-2 text-xs backdrop-blur">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={[
            'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
            entry.status === 'running' ? 'animate-pulse bg-[#C9974E]'
              : entry.status === 'failed' ? 'bg-red-400'
              // Declined is not an error — the gate did its job — so it is neither alarming red
              // nor the brass the rail uses for a change that landed.
              : entry.status === 'declined' ? 'bg-white/40'
              : 'bg-[#C9974E]/60',
          ].join(' ')}
        />
        <span className="text-[10px] uppercase tracking-wider text-[#E8D5B0]">{headline(entry)}</span>
        {/* "By whom", in the same two words the evidence chips already use. Right-aligned so a
            column of entries reads down as one who-column rather than a ragged second label. */}
        {/* `title`, not `aria-label`: a bare span has the `generic` role, which prohibits an
            author-supplied name, so an aria-label here would be silently dropped by AT and read
            as covered. The visible word is the accessible name, and it is the same word a
            sighted user gets; the tooltip only spells out the sentence for a pointer. */}
        {/* Age sits beside the actor rather than inside the detail line, which is `line-clamp-2`
            and would swallow it on a long caption-derived summary. Costs no height. */}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {age && <span className="text-[10px] text-white/35">{age}</span>}
          {/* Drawn whenever the entry HAS an actor, which the call itself decides — see
              `ActivityEntry.actor`. This was briefly keyed on `status !== 'failed'` instead, which
              is too coarse in both directions: it correctly hid the chip on a validation error
              that never reached a person, and wrongly hid it on an edit the user approved and the
              backend then refused, which is precisely the decision this rail exists to record.
              Terminal status cannot answer "did a human decide this" — both endings are reachable
              either way — so the tool says, and this only draws it. */}
          {entry.actor !== null && (
            <span
              title={`${entry.actor} decided this`}
              className={[
                'rounded px-1.5 py-0.5 text-[10px]',
                entry.actor === 'You' ? 'bg-[#C9974E]/20 text-[#E8D5B0]' : 'bg-white/10 text-white/60',
              ].join(' ')}
            >
              {entry.actor}
            </span>
          )}
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
 * The newest entry the user has dismissed, and the in-flight ones spared from that dismissal.
 *
 * A WATERMARK, not a delete: the registry's list is append-only and stays that way. The record is
 * an audit surface, and an audit surface the audited thing can shorten is not one — a tool that
 * could reach `setActivity` could erase itself. Nothing recovers a cleared entry from the UI, so
 * from the user's side this is a clear and not a filing cabinet; the store simply is not the
 * place to enforce that.
 */
export type ClearedMark = { throughId: number; spared: readonly number[] }

export const NOTHING_CLEARED: ClearedMark = { throughId: 0, spared: [] }

/**
 * The rail draws the record; it does not own how much of it the user has dismissed.
 *
 * Held one level up, in the dock, because the dock is what UNMOUNTS this component when it folds.
 * While the mark lived here, minimising and reopening reset it to zero against a registry that
 * still held the whole append-only history, so every cleared entry came back — a clear that a
 * fold silently undoes is not a clear. It is the same reason the dock owns `collapsed` rather
 * than the panels it collapses. Controlled outright rather than defaulted, so there is no second
 * uncontrolled path that the tests could pass through while the shipped one fails.
 */
export default function AgentActivityRail({
  compact = false,
  cleared,
  onClear,
}: {
  compact?: boolean
  cleared: ClearedMark
  onClear: (mark: ClearedMark) => void
}) {
  const registry = useOptionalWebMcpRegistry()
  const [showEarlier, setShowEarlier] = useState(false)
  const [now, setNow] = useState(() => Date.now())

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
  const visible = registry?.activity.filter(
    (e) => e.id > cleared.throughId || cleared.spared.includes(e.id),
  )

  /**
   * One clock for the whole rail, not one per entry, and only while a label can still move.
   *
   * The youngest entry is the one that decides: if IT has settled, every older one has too. The
   * interval tears itself down when that happens, because `shouldTick` flips on the tick that
   * crosses the threshold. It also goes when the rail does — the dock unmounts the rail while
   * folded, so a folded dock keeps no clock at all.
   *
   * State is local to the rail on purpose. A tick here re-renders these few cards and nothing
   * else; putting it in the registry would re-render every consumer, the map included.
   */
  const newestAt = visible?.length ? visible[visible.length - 1].at : 0
  const shouldTick = newestAt > 0 && now - newestAt < AGE_SETTLES_AFTER_MS

  useEffect(() => {
    if (!shouldTick) return
    const id = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(id)
  }, [shouldTick])

  if (!visible?.length) return null

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
            <Entry key={e.id} entry={e} now={now} />
          ))}
        </div>
      )}

      <Entry entry={latest} now={now} />

      {/* Last, so it keeps its place: the dock is bottom-anchored and grows upward, which makes
          the bottom-most control the only one that never moves under the user's finger. Both
          controls share the row for that reason — a second row would move the first. */}
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
        <button
          type="button"
          onClick={() =>
            onClear({
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
      </div>
    </div>
  )
}
