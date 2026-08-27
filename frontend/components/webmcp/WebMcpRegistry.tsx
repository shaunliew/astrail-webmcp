'use client'

import type { TripBundle } from '@/lib/trip/backend-types'
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

/**
 * Agent actions are announced in the app's words, never the tool's. A user should read
 * "MOVED  7 - Senso-ji -> Day 3", not `move_place({place_ref:"7"})`.
 */
const LABELS: Record<string, string> = {
  get_app_state: 'READING', list_trips: 'READING', get_itinerary: 'READING',
  get_place_evidence: 'CHECKING', get_map_view: 'LOOKING', list_saved_reels: 'READING',
  show_on_map: 'SHOWING', set_map_mode: 'SWITCHING',
  save_reels: 'SAVING', plan_trip_from_reels: 'PLANNING', get_trip_progress: 'WATCHING',
  move_place: 'MOVED', remove_place: 'REMOVED',
}

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

export type ActivityEntry = {
  id: number
  tool: string
  /** Written in the app's vocabulary, never the tool's. */
  label: string
  detail: string | null
  status: 'running' | 'done' | 'failed'
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
  endActivity: (id: number, status: 'done' | 'failed', detail?: string) => void
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
  const beginActivity = useCallback((tool: string) => {
    const id = ++activitySeq.current
    setActivity((prev) => [
      ...prev.slice(-4),   // a tail, not a transcript
      { id, tool, label: LABELS[tool] ?? 'WORKING', detail: null, status: 'running', at: Date.now() },
    ])
    return id
  }, [])

  const endActivity = useCallback((id: number, status: 'done' | 'failed', detail?: string) => {
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
