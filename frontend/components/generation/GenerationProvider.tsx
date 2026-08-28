'use client'

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { StreamEvent } from '@/lib/trip/backend-types'
import { streamGeneration } from '@/lib/trip/api'
import { getAccessToken } from '@/lib/supabase/session'
import { createGenerationStore, type GenerationStore } from '@/lib/webmcp/generation'
import { useOptionalSharedMap } from '@/components/map/MapProvider'
import { relightDurationMs } from '@/components/map/relight'

/**
 * One generation run, owned by the /app shell rather than by a page.
 *
 * A trip started by `plan_trip_from_reels` used to stream into a private store inside GlobalTools
 * that nothing rendered from, so the agent narrated into chat while the website sat still. The
 * page's own generation, meanwhile, lived in SavedReelsFlow's local state and died on unmount.
 * Neither could serve the other.
 *
 * This owns the parts that must outlive a page: the single EventSource, the full event history
 * (GenerationScene needs every event, not the store's compressed snapshot), the active-run lock,
 * and the terminal navigation. It deliberately does NOT own the reels workflow — phase, trays,
 * selection and inbox stay in SavedReelsFlow, which subscribes to this and maps an active run
 * onto its own `generating` phase.
 */

export type GenerationStatus = 'idle' | 'generating' | 'complete' | 'failed' | 'unknown'

export type GenerationRun = {
  /** Increments per run. Every async callback carries the id it was created under, so a stale
   *  one cannot cancel a newer stream or navigate to a finished trip. */
  runId: number
  tripId: string | null
  status: GenerationStatus
  events: StreamEvent[]
}

export type GenerationApi = {
  run: GenerationRun
  /** True while a run is streaming. Callers MUST check this BEFORE creating a backend job —
   *  a second generation costs real Apify and OpenAI credit, and the first one keeps running. */
  isBusy: boolean
  /** Adopt a created trip. Returns false when a run is already active and nothing was started. */
  start: (tripId: string) => boolean
  /** Synchronous, and the one to check BEFORE calling the backend. `isBusy` is derived from
   *  rendered state and lags a tick; this reads the lock itself, which is what a second click
   *  in the same tick actually races against. */
  canStart: () => boolean
  /** The agent-facing snapshot store, so get_trip_progress reads the same run the page renders. */
  store: GenerationStore
}

const IDLE: GenerationRun = { runId: 0, tripId: null, status: 'idle', events: [] }

const Ctx = createContext<GenerationApi | null>(null)

/** A terminal result whose payload carries `{error: …}` is a FAILURE. A leased backend failure can
 *  emit only that, with no preceding `error` event (runner.py:154 → streaming.py:53), and treating
 *  every result as success left the agent telling the user a dead run had finished. */
function readResult(content: string, fallbackTripId: string | null) {
  try {
    const parsed = JSON.parse(content) as { trip_id?: string; error?: unknown }
    return { tripId: parsed.trip_id ?? fallbackTripId, failed: Boolean(parsed.error) }
  } catch {
    return { tripId: fallbackTripId, failed: false }
  }
}

export default function GenerationProvider({
  children,
  /** Injected so tests need no EventSource and no Supabase session. */
  openStream = streamGeneration,
  readToken = getAccessToken,
}: {
  children: React.ReactNode
  openStream?: typeof streamGeneration
  readToken?: () => Promise<string>
}) {
  const router = useRouter()
  // Optional: the relight is a signature beat, not a precondition for owning the run.
  const sharedMap = useOptionalSharedMap()
  const [run, setRun] = useState<GenerationRun>(IDLE)
  const storeRef = useRef(createGenerationStore())
  // The live run id, readable synchronously. `run.runId` lags behind a setState during the same
  // tick, and `start` has to reject a second call before React has committed anything.
  const activeRef = useRef(0)
  const busyRef = useRef(false)

  const start = useCallback((tripId: string) => {
    // The lock is checked and taken synchronously. Two clicks in one tick, or a manual click
    // racing an agent approval, must not both reach the backend.
    if (busyRef.current) return false
    busyRef.current = true
    const runId = activeRef.current + 1
    activeRef.current = runId

    // Initialize BEFORE the token round-trip. Otherwise the tool has already returned a trip_id
    // while an immediate get_trip_progress reports that no trip exists.
    setRun({ runId, tripId, status: 'generating', events: [] })

    storeRef.current.start(tripId, (storeOnEvent, storeOnFail) => {
      let handle: { cancel: () => void } | null = null
      let cancelled = false
      const live = () => !cancelled && activeRef.current === runId

      void (async () => {
        let token: string
        try {
          token = await readToken()
        } catch {
          // A token failure is not silence: without this the run sits on "generating" for ever
          // and the agent polls a stream that will never open.
          if (live()) { busyRef.current = false; setRun((r) => (r.runId === runId ? { ...r, status: 'unknown' } : r)) }
          storeOnFail()
          return
        }
        if (!live()) return
        handle = openStream(
          tripId,
          token,
          (event) => {
            if (!live()) return
            storeOnEvent(event)
            setRun((r) => (r.runId === runId ? { ...r, events: [...r.events, event] } : r))
            if (event.type === 'result') {
              const { tripId: finishedId, failed } = readResult(event.content, tripId)
              busyRef.current = false
              setRun((r) => (r.runId === runId ? { ...r, status: failed ? 'failed' : 'complete' } : r))
              // Navigation belongs to the shell, not to the page: leaving /app mid-run must not
              // orphan the trip the user is waiting for. The relight is the signature beat -
              // night while it builds, dawn when it lands - and it must fire BEFORE the push so
              // the preset carries across the route handoff (MapProvider.release keeps it).
              if (!failed && finishedId) {
                sharedMap?.setLightPreset('dawn', relightDurationMs())
                router.push(`/app/trip/${finishedId}`)
              }
            }
          },
          () => {
            // EventSource reconnected and the backend replays every event from the start, so the
            // history has to be dropped or it doubles.
            if (live()) setRun((r) => (r.runId === runId ? { ...r, events: [] } : r))
          },
          () => {
            if (live()) { busyRef.current = false; setRun((r) => (r.runId === runId ? { ...r, status: 'unknown' } : r)) }
            storeOnFail()
          },
        )
      })()

      return { cancel: () => { cancelled = true; handle?.cancel() } }
    })

    return true
  }, [openStream, readToken, router, sharedMap])

  const canStart = useCallback(() => !busyRef.current, [])

  const value = useMemo<GenerationApi>(
    () => ({ run, isBusy: run.status === 'generating', start, canStart, store: storeRef.current }),
    [run, start, canStart],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** Throws outside the provider — a caller that needs the run cannot meaningfully continue. */
export function useGeneration(): GenerationApi {
  const v = useContext(Ctx)
  if (!v) throw new Error('useGeneration must be used inside GenerationProvider')
  return v
}

/** Null outside the provider, for components that render in both shells. */
export function useOptionalGeneration(): GenerationApi | null {
  return useContext(Ctx)
}
