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
   * The same action named in a form that claims nothing — used the moment a call ends in
   * anything but a change.
   *
   * `label` is past tense for every write, and past tense is an assertion: `REMOVED` says the
   * stop is gone. On a declined approval card, or a backend refusal, it was gone from the record
   * and still on the map. There is no way to negate a past-tense word in place, so the entry
   * switches to the attempt plus what became of it — `REMOVE DECLINED`, `MOVE FAILED`.
   *
   * A running entry deliberately keeps `label`. For the reads, which are most calls, `label` is
   * already the present participle a live call wants (`READING`), and the pulsing dot marks the
   * few seconds a write spends there.
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
  get_app_state:        { label: 'READING',     attempt: 'READ',       actor: 'Astrail', changes: false },
  list_trips:           { label: 'READING',     attempt: 'READ',       actor: 'Astrail', changes: false },
  get_itinerary:        { label: 'READING',     attempt: 'READ',       actor: 'Astrail', changes: false },
  list_saved_reels:     { label: 'READING',     attempt: 'READ',       actor: 'Astrail', changes: false },
  get_place_evidence:   { label: 'CHECKING',    attempt: 'CHECK',      actor: 'Astrail', changes: false },
  get_map_view:         { label: 'LOOKING',     attempt: 'LOOK',       actor: 'Astrail', changes: false },
  get_trip_progress:    { label: 'WATCHING',    attempt: 'WATCH',      actor: 'Astrail', changes: false },
  show_on_map:          { label: 'SHOWING',     attempt: 'SHOW',       actor: 'Astrail', changes: false },
  set_map_mode:         { label: 'SWITCHING',   attempt: 'SWITCH',     actor: 'Astrail', changes: false },
  save_reels:           { label: 'SAVING',      attempt: 'SAVE',       actor: 'Astrail', changes: true },
  // The one durable edit that reaches the database without an approval card, which is exactly
  // why the rail has to name it: unasked, unannounced anywhere else, and not reversible.
  move_place:           { label: 'MOVED',       attempt: 'MOVE',       actor: 'Astrail', changes: true },
  plan_trip_from_reels: { label: 'PLANNING',    attempt: 'PLAN',       actor: 'You',     changes: true },
  add_place:            { label: 'ADDED',       attempt: 'ADD',        actor: 'You',     changes: true },
  remove_place:         { label: 'REMOVED',     attempt: 'REMOVE',     actor: 'You',     changes: true },
  set_trip_dates:       { label: 'RESCHEDULED', attempt: 'RESCHEDULE', actor: 'You',     changes: true },
  replan_trip:          { label: 'REWROTE',     attempt: 'REWRITE',    actor: 'You',     changes: true },
}

/**
 * A tool the table has not met. `changes: true` is the fail-safe direction: it costs an extra
 * "can't undo" line on something harmless, where guessing `false` would hide a real write.
 */
const UNKNOWN_TOOL: ToolFacts = { label: 'WORKING', attempt: 'WORK', actor: 'Astrail', changes: true }

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
  /** Called from inside a tool's execute; resolves when the user answers. */
  requestConfirm: (summary: string) => Promise<boolean>
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
  beginActivity: (tool: string) => number
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
  const beginActivity = useCallback((tool: string) => {
    const id = ++activitySeq.current
    const facts = TOOLS[tool] ?? UNKNOWN_TOOL
    setActivity((prev) => [...prev, { id, tool, ...facts, detail: null, status: 'running', at: Date.now() }])
    return id
  }, [])

  const endActivity = useCallback((id: number, status: ActivityStatus, detail?: string) => {
    setActivity((prev) => prev.map((e) => (e.id === id ? { ...e, status, detail: detail ?? null } : e)))
  }, [])

  /**
   * One approval at a time. A queue would let an agent stack irreversible actions behind a
   * dialog the user has not read yet, which is exactly what the gate exists to prevent.
   */
  const requestConfirm = useCallback((summary: string) => {
    return new Promise<boolean>((resolve) => {
      setPending((existing) => {
        if (existing) { resolve(false); return existing }   // busy: decline rather than queue
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
