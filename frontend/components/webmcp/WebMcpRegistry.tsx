'use client'

import type { TripBundle } from '@/lib/trip/backend-types'
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

/**
 * What the rail can say about a call, knowing only which tool was named.
 *
 * `RegisterTools` passes the tool NAME, so WHAT an action is comes entirely from this table —
 * a per-call claim assembled from a tool's prose output would be a claim about untrusted text
 * (guardrail #11), and a record that can be written by the thing it audits is not a record.
 *
 * Exactly one thing about a call cannot be a static property, and pretending otherwise is what
 * made the rail lie: whether the action HAPPENED. That arrives as `ActivityStatus`, a closed set
 * our own code picks (`readToolOutcome` believes nothing else), never a phrase parsed out of a
 * reply. The table still owns the vocabulary; the call only says which of these words applies.
 */
type ToolFacts = {
  /**
   * Agent actions are announced in the app's words, never the tool's. A user should read
   * "MOVED  7 - Senso-ji -> Day 3", not `move_place({place_ref:"7"})`.
   */
  label: string
  /**
   * The same action named in a form that claims nothing — used for EVERY state that is not a
   * completed change: still running, declined, failed.
   *
   * `label` is past tense for the five writes that have a distinct completed form, and past tense
   * is an assertion: `REMOVED` says the stop is gone. It was rendered on a declined card, on a
   * backend refusal, and — the case that lasts longest and is most visible — while the approval
   * card is still on screen waiting for an answer. A judge reading the card is looking at a record
   * that already says the removal happened.
   *
   * There is no way to negate a past-tense word in place, so a non-completed entry uses this one
   * instead: bare while the call is in flight, and with what became of it once it ends —
   * `REMOVE DECLINED`, `MOVE FAILED`.
   *
   * For every OTHER tool the two are the same string, deliberately. `READING`, `SAVING`,
   * `PLANNING` are present participles that assert nothing and already read correctly in flight,
   * so the rule "a non-completed entry shows `attempt`" costs them nothing — where forcing a bare
   * stem on them would turn a correct `SAVING` into a worse `SAVE` to fix a lie they never told.
   */
  attempt: string
  /**
   * Who decided the call happens — the accountability half of an audit log.
   *
   * Every entry here is a tool call, so the agent always PERFORMS it; the only place the user's
   * own hand enters is the approval card. So this reads "whose decision was this", which stays
   * true on both branches of a card: a declined removal was still the user's call. The two words
   * are the app's existing ones for the same distinction (`EvidenceChip`: requested_by_you ->
   * "You", suggested_by_astrail -> "Astrail").
   */
  actor: 'You' | 'Astrail'
  /**
   * True when the call writes something that outlives the page.
   *
   * Deliberately NOT `readOnlyHint`. That hint means "safe to call speculatively" and is false
   * for `show_on_map` because a camera fly is noticeable — but a camera fly changes nothing a
   * user could want back, and labelling it a change would make the record cry wolf.
   */
  changes: boolean
}

const TOOLS: Record<string, ToolFacts> = {
  get_app_state:        { label: 'READING',     attempt: 'READING',    actor: 'Astrail', changes: false },
  list_trips:           { label: 'READING',     attempt: 'READING',    actor: 'Astrail', changes: false },
  get_itinerary:        { label: 'READING',     attempt: 'READING',    actor: 'Astrail', changes: false },
  list_saved_reels:     { label: 'READING',     attempt: 'READING',    actor: 'Astrail', changes: false },
  get_place_evidence:   { label: 'CHECKING',    attempt: 'CHECKING',   actor: 'Astrail', changes: false },
  get_map_view:         { label: 'LOOKING',     attempt: 'LOOKING',    actor: 'Astrail', changes: false },
  get_trip_progress:    { label: 'WATCHING',    attempt: 'WATCHING',   actor: 'Astrail', changes: false },
  show_on_map:          { label: 'SHOWING',     attempt: 'SHOWING',    actor: 'Astrail', changes: false },
  set_map_mode:         { label: 'SWITCHING',   attempt: 'SWITCHING',  actor: 'Astrail', changes: false },
  save_reels:           { label: 'SAVING',      attempt: 'SAVING',     actor: 'Astrail', changes: true },
  // 'You' since the move started raising its own approval card. It was the one durable edit an
  // agent made on its own initiative, which is why the rail had to name it at all; now the same
  // hand answers for it as for the other four, and `actor` follows the card rather than the
  // tool's history.
  move_place:           { label: 'MOVED',       attempt: 'MOVE',       actor: 'You',     changes: true },
  plan_trip_from_reels: { label: 'PLANNING',    attempt: 'PLANNING',   actor: 'You',     changes: true },
  add_place:            { label: 'ADDED',       attempt: 'ADD',        actor: 'You',     changes: true },
  remove_place:         { label: 'REMOVED',     attempt: 'REMOVE',     actor: 'You',     changes: true },
  set_trip_dates:       { label: 'RESCHEDULED', attempt: 'RESCHEDULE', actor: 'You',     changes: true },
  replan_trip:          { label: 'REWROTE',     attempt: 'REWRITE',    actor: 'You',     changes: true },
}

/**
 * A tool the table has not met. `changes: true` is the fail-safe direction: it costs an extra
 * "can't undo" line on something harmless, where guessing `false` would hide a real write.
 */
const UNKNOWN_TOOL: ToolFacts = { label: 'WORKING', attempt: 'WORKING', actor: 'Astrail', changes: true }

/**
 * A view of what is currently registered, so the UI can SHOW the user what the agent can do.
 *
 * WanderNote surfaces its tool list in-page, and it is worth copying for three separate reasons:
 * a first-time user cannot ask for a capability they cannot see; a judge gets immediate proof
 * the integration is real (and it should agree with ChatGPT's own address-bar list); and it is
 * our dev inspector for free, so there is no separate debug route to build and then hide.
 */

export type RegisteredToolView = {
  name: string
  description: string
  readOnly: boolean
  registered: boolean
}

/**
 * How a call ended, as the record has to distinguish them.
 *
 * `done` is the only one that may be written in the past tense or carry a "can't undo" line.
 * `declined` and `failed` both mean nothing changed; they are kept apart because WHO stopped it
 * is the accountability question this rail exists to answer.
 */
export type ActivityStatus = 'done' | 'declined' | 'failed'

export type ActivityEntry = ToolFacts & {
  id: number
  tool: string
  /**
   * What this entry is about, when the caller knows and it matters — a trip id, today.
   *
   * Null for every entry `RegisterTools` opens, and that is the useful half of it rather than a
   * gap. Those are opened by NAME, before `execute` runs, so they cover the approval card's whole
   * life: a `replan_trip` waiting on an unanswered card is `running` for as long as the user
   * reads it, and reading a bare `tool === 'replan_trip' && status === 'running'` as "this trip's
   * summaries are being rewritten" therefore said so while nothing was happening — and went on
   * saying it right up until the user DECLINED, which proves no rewrite ever started.
   *
   * A subject is written only where the work is genuinely under way and its target is known
   * (`GlobalTools::runReplan`, at the moment the request goes out). So a consumer that matches on
   * `subject === myTripId` gets both answers at once: not during the card, and not for somebody
   * else's trip. It stays on the rail's own entries rather than becoming a second signal beside
   * them, because two sources can disagree about one rewrite.
   */
  subject: string | null
  detail: string | null
  status: 'running' | ActivityStatus
  at: number
}

export type PendingConfirm = {
  summary: string
  resolve: (approved: boolean) => void
}

type RegistryValue = {
  tools: RegisteredToolView[]
  /** An approval the agent is waiting on. Rendered by <AgentConfirm/>. */
  pending: PendingConfirm | null
  /**
   * Called from inside a tool's execute; resolves when the user answers — or `'unavailable'`
   * when no card could be shown, which is NOT an answer and must never be reported as one.
   */
  requestConfirm: (summary: string) => Promise<boolean | 'unavailable'>
  /**
   * The trip currently open on screen, if any.
   *
   * A REF, not state, and deliberately so. Data tools are registered globally (an agent must be
   * able to answer "what's on day 2 of my Kyoto trip?" from anywhere), but when the user IS
   * looking at a trip, the tool should use that one rather than asking "which trip?". Holding it
   * in state would re-create the context value on every trip load and re-trigger the exact
   * render loop fixed earlier; a ref gives the tools a live read with zero re-render.
   */
  openTrip: React.MutableRefObject<unknown>
  /**
   * The open trip page's own re-fetch.
   *
   * An edit tool that only calls getTrip() pulls fresh rows and then drops them on the floor:
   * the rendered bundle lives in TripWorkspace's state, not in the shell. That is why every
   * agent edit required a manual page refresh to become visible. The page publishes its
   * refresher here so a tool can make the UI catch up with what it just changed.
   */
  refreshOpenTrip: React.MutableRefObject<(() => Promise<TripBundle | null>) | null>
  /**
   * The open Saved Reels page's own re-fetch, published the same way and for the same reason.
   *
   * A reel saved by a tool landed in the database and nowhere on screen: the card list lives in
   * SavedReelsFlow's state, so it kept rendering what it had loaded on mount. The reel only
   * appeared after a manual page reload, which reads as the save having silently failed.
   */
  refreshSavedReels: React.MutableRefObject<(() => Promise<void>) | null>
  /**
   * A tool-started organize job, handed to the Saved Reels page so it can follow it.
   *
   * The page already knows how to follow a job it started itself; one started by an agent lands
   * outside that state entirely, which is why an agent-triggered extraction showed no progress at
   * all. Passing the id lets the page derive live per-reel status from the JOB — the authoritative
   * record — instead of anything being written into `saved_reels` to represent it.
   */
  adoptOrganizeJob: React.MutableRefObject<((jobId: string) => void) | null>
  /** Visible log of what the agent did. Reads included — a silent read cannot be consented to. */
  activity: ActivityEntry[]
  /** `subject` names what the work is about (a trip id) — see `ActivityEntry.subject`. */
  beginActivity: (tool: string, subject?: string) => number
  endActivity: (id: number, status: ActivityStatus, detail?: string) => void
  /** Whether `document.modelContext` exists at all — false in an ordinary browser. */
  supported: boolean
  report: (view: RegisteredToolView) => void
  withdraw: (name: string) => void
  setSupported: (v: boolean) => void
}

const Ctx = createContext<RegistryValue | null>(null)

export function useWebMcpRegistry(): RegistryValue {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useWebMcpRegistry must be used inside <WebMcpRegistryProvider>')
  return ctx
}

/** Safe outside the provider — the landing page renders without one. */
export function useOptionalWebMcpRegistry(): RegistryValue | null {
  return useContext(Ctx)
}

export function WebMcpRegistryProvider({ children }: { children: React.ReactNode }) {
  const [tools, setTools] = useState<RegisteredToolView[]>([])
  const [supported, setSupported] = useState(false)
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const activitySeq = useRef(0)
  const openTrip = useRef<unknown>(null)
  const refreshOpenTrip = useRef<(() => Promise<TripBundle | null>) | null>(null)
  const refreshSavedReels = useRef<(() => Promise<void>) | null>(null)
  const adoptOrganizeJob = useRef<((jobId: string) => void) | null>(null)

  // Stable by construction. The render-loop bug earlier came from depending on the CONTEXT VALUE
  // (memoized on state) instead of on callbacks like these, so keep these dependency-free.

  // Every call is kept for the session. The `slice(-4)` this replaces made the rail a fading
  // tail of five: the fifth read silently deleted the edit the user was about to question, and
  // an audit log that discards its own oldest entries is the one thing an audit log may not do.
  // The rail, not the store, is what stays compact — it collapses to the newest entry.
  const beginActivity = useCallback((tool: string, subject?: string) => {
    const id = ++activitySeq.current
    const facts = TOOLS[tool] ?? UNKNOWN_TOOL
    setActivity((prev) => [
      ...prev,
      { id, tool, ...facts, subject: subject ?? null, detail: null, status: 'running', at: Date.now() },
    ])
    return id
  }, [])

  const endActivity = useCallback((id: number, status: ActivityStatus, detail?: string) => {
    setActivity((prev) => prev.map((e) => (e.id === id ? { ...e, status, detail: detail ?? null } : e)))
  }, [])

  /**
   * One approval at a time, and a THIRD answer for the case where nobody was asked.
   *
   * A queue would let an agent stack irreversible actions behind a dialog the user has not read
   * yet, which is exactly what the gate exists to prevent — so a second request while one is
   * pending is still refused on the spot. What changed is the channel it comes back through. It
   * used to resolve `false`, which is the same value a real refusal produces, so the tool said
   * "The user declined" and the rail wrote it down against "You" — to someone who had never been
   * shown a card. That is a false statement handed to the AGENT, which repeats it to the user as
   * fact, and it is the same family as the rail recording a declined removal as a completed one.
   *
   * `'unavailable'` is a value our own code writes and no user action can produce, so the two
   * cases can never again be mistaken for each other. It is deliberately not a rejection: a busy
   * registry is an ordinary, recoverable state, and throwing would make every caller wrap a
   * try/catch around a question.
   */
  const requestConfirm = useCallback((summary: string) => {
    return new Promise<boolean | 'unavailable'>((resolve) => {
      setPending((existing) => {
        if (existing) { resolve('unavailable'); return existing }   // busy: refuse, do not answer for them
        return {
          summary,
          resolve: (approved: boolean) => { setPending(null); resolve(approved) },
        }
      })
    })
  }, [])

  const report = useCallback((view: RegisteredToolView) => {
    setTools((prev) => {
      const rest = prev.filter((t) => t.name !== view.name)
      // Sorted by name so the list does not reshuffle as tools register in effect order.
      return [...rest, view].sort((a, b) => a.name.localeCompare(b.name))
    })
  }, [])

  const withdraw = useCallback((name: string) => {
    setTools((prev) => prev.filter((t) => t.name !== name))
  }, [])

  const value = useMemo<RegistryValue>(
    () => ({
      tools, supported, pending, requestConfirm, activity, beginActivity, endActivity, openTrip, refreshOpenTrip, refreshSavedReels, adoptOrganizeJob,
      report, withdraw, setSupported,
    }),
    [tools, supported, pending, requestConfirm, activity, beginActivity, endActivity, report, withdraw],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
