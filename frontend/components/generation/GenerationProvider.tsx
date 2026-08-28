'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { StreamEvent } from '@/lib/trip/backend-types'
import { streamGeneration } from '@/lib/trip/api'
import { getAccessToken } from '@/lib/supabase/session'
import {
  createGenerationStore, readResultVerdict, statusFromResult,
  type GenerationStore, type ResultVerdict,
} from '@/lib/webmcp/generation'
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

/**
 * The single-run lock, already TAKEN.
 *
 * Both entry points do the same three things: decide whether they may run, create a backend job,
 * then attach it to the screen. The middle step is an awaited network round-trip, so a lock that
 * is merely *read* in step one is not held during it — a manual click and an agent approval both
 * passed the check, both POSTed, and two paid generations existed before either could be told no.
 * Reserving collapses "may I" and "I have" into one synchronous step, which is the only shape
 * that survives the gap.
 */
export type RunReservation = {
  /** Commit: the backend job exists. Puts the run on screen and opens the one stream. Starts
   *  nothing once the reservation has settled — and a begin() arriving after the reservation
   *  EXPIRED reports the job as orphaned instead. See RESERVATION_DEADLINE_MS. */
  begin: (tripId: string) => void
  /** Abandon: no backend job was created. Hands the lock straight back. */
  release: () => void
}

export type GenerationApi = {
  run: GenerationRun
  /**
   * Take the lock, or `null` when a run already holds it.
   *
   * Call this BEFORE creating the backend job — a second generation spends real Apify and OpenAI
   * credit, does not stop the first, and cannot even be recovered by `get_trip_progress`. Every
   * caller owes the reservation exactly one `begin()` or one `release()`; whichever lands first
   * settles it, and the second is ignored. A caller that owes neither is not trusted to block the
   * next one for ever: the reservation expires on its own after RESERVATION_DEADLINE_MS, and a
   * begin() that lands after that starts no stream — it reports the job as orphaned.
   */
  reserve: () => RunReservation | null
  /** The agent-facing snapshot store, so get_trip_progress reads the same run the page renders. */
  store: GenerationStore
}

const IDLE: GenerationRun = { runId: 0, tripId: null, status: 'idle', events: [] }

/**
 * How long the shell waits for a session token before giving the run up.
 *
 * This runs AFTER the backend job has been created, so a token that never settles is not a run
 * that never started — it is a paid run with nothing watching it, a wait screen with no way out,
 * and the lock held for the rest of the session. A rejection was always handled; silence was not.
 */
export const TOKEN_TIMEOUT_MS = 15_000

/**
 * How long a reservation may be held before the lock comes back on its own.
 *
 * TOKEN_TIMEOUT_MS bounds the token fetch INSIDE this provider, which runs after begin(). It
 * cannot see the caller's own pre-commit work — a getAccessToken() and the POST that creates the
 * job — and that work happens with the reservation already held. A caller that hangs there calls
 * neither begin() nor release(), so the lock stays taken for the rest of the session and every
 * later generation, the user's and the agent's, is refused with "a trip is already being built"
 * while nothing is being built at all.
 *
 * 30s = 15s for the caller's own token fetch (the same fetch this file bounds at
 * TOKEN_TIMEOUT_MS) plus 15s for the POST. `POST /generate-trip` inserts the job row and returns
 * — it does not wait for the 60-180s pipeline — and it is served by an always-on Render instance
 * with no cold start, so 15s is already many times what it costs. Long enough that a slow but
 * honest POST is never cut off; short enough that a wedged one costs one generation instead of
 * the whole session.
 */
export const RESERVATION_DEADLINE_MS = 30_000

/** Reject after `ms` rather than await a promise that may never settle. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

const Ctx = createContext<GenerationApi | null>(null)

/** The trip the result points at. WHETHER it succeeded is not decided here — `readResultVerdict`
 *  owns that rule, so the page and the agent-facing store can never reach opposite verdicts on the
 *  same frame (they did: the page read failed while get_trip_progress said the trip was ready). */
function readResult(content: string, fallbackTripId: string | null): { tripId: string | null; verdict: ResultVerdict } {
  let tripId = fallbackTripId
  try {
    tripId = (JSON.parse(content) as { trip_id?: string }).trip_id ?? fallbackTripId
  } catch {
    // Unreadable payload — the id we started with is still the right one to open.
  }
  return { tripId, verdict: readResultVerdict(content) }
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
  // tick, and a reservation has to fence the next caller out before React has committed anything.
  const activeRef = useRef(0)
  const busyRef = useRef(false)
  // A MOUNTED flag, which the run id is not. A reservation can be taken and committed from a
  // detached async continuation (a page awaiting generateTrip while the user signs out), and a
  // stream opened after the shell has gone is one nothing will ever cancel or render.
  const deadRef = useRef(false)

  // Cancelling the live stream is what actually silences the callbacks — no stream, no setRun and
  // no router.push pulling a signed-out user back into /app. Re-armed on mount, because React
  // StrictMode mounts, unmounts and mounts again in development, and a one-way flag would leave
  // the second mount permanently unable to start anything.
  useEffect(() => {
    deadRef.current = false
    return () => {
      deadRef.current = true
      storeRef.current.stop()   // cancels the live stream, and hands the lock back with it
    }
  }, [])

  /** Attach a committed run to the screen and open its one stream. The lock is ALREADY held. */
  const beginRun = useCallback((runId: number, tripId: string) => {
    // Initialize BEFORE the token round-trip. Otherwise the tool has already returned a trip_id
    // while an immediate get_trip_progress reports that no trip exists.
    setRun({ runId, tripId, status: 'generating', events: [] })

    storeRef.current.start(tripId, (storeOnEvent, storeOnFail) => {
      let handle: { cancel: () => void } | null = null
      let cancelled = false
      const live = () => !cancelled && activeRef.current === runId

      /**
       * Every way out of a run that is not a result: the lock goes back, and both views say so.
       *
       * Guarded on `live()` as one piece. `storeOnFail` is not bound to a run — it writes to
       * whatever snapshot is current — so a late failure from a cancelled first stream used to
       * mark the SECOND run's snapshot `unknown` while it was streaming perfectly well.
       */
      const giveUp = () => {
        if (!live()) return
        busyRef.current = false
        setRun((r) => (r.runId === runId ? { ...r, status: 'unknown' } : r))
        storeOnFail()
      }

      void (async () => {
        let token: string
        try {
          // Timed out, not merely try/caught: a getAccessToken that REJECTS was always handled,
          // but one that never settles left the run generating for ever with the lock held.
          token = await withTimeout(readToken(), TOKEN_TIMEOUT_MS)
        } catch {
          giveUp()
          return
        }
        if (!live()) return
        try {
          handle = openStream(
            tripId,
            token,
            (event) => {
              if (!live()) return
              storeOnEvent(event)
              setRun((r) => (r.runId === runId ? { ...r, events: [...r.events, event] } : r))
              if (event.type === 'result') {
                const { tripId: finishedId, verdict } = readResult(event.content, tripId)
                busyRef.current = false
                setRun((r) => (r.runId === runId ? { ...r, status: statusFromResult(event.content) } : r))
                // Navigation belongs to the shell, not to the page: leaving /app mid-run must not
                // orphan the trip the user is waiting for. The relight is the signature beat -
                // night while it builds, dawn when it lands - and it must fire BEFORE the push so
                // the preset carries across the route handoff (MapProvider.release keeps it).
                //
                // `success`, not "not failed": an unreadable frame is no evidence a trip exists,
                // and navigating on one opened a trip page for a run that may have died.
                if (verdict === 'success' && finishedId) {
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
            giveUp,
          )
        } catch {
          // openStream constructs an EventSource, which throws SYNCHRONOUSLY on a URL it rejects.
          // In this detached async call that became an unhandled rejection: no stream, no status,
          // and the lock held for the rest of the session.
          giveUp()
        }
      })()

      return {
        cancel: () => {
          cancelled = true
          handle?.cancel()
          // Whoever cancels a run releases its lock — store.stop() from outside, or the shell
          // unmounting — or nothing ever would. Guarded on ownership: store.start() cancels the
          // PREVIOUS stream on its way in, and that must not free the lock the incoming run has
          // just taken.
          if (activeRef.current !== runId) return
          busyRef.current = false
          // ...and the run must stop SAYING it is generating. The page renders the wait screen
          // from exactly this, so a cancelled stream that left the status alone kept the screen
          // up with nothing behind it left to end it. A run that already reached a verdict keeps
          // the verdict it reached.
          setRun((r) => (r.runId === runId && r.status === 'generating' ? { ...r, status: 'unknown' } : r))
        },
      }
    })
  }, [openStream, readToken, router, sharedMap])

  /**
   * A job that exists with nothing watching it.
   *
   * Only reachable from a `begin()` that arrives after its reservation expired — which is itself
   * the proof that the POST returned and a real trip is being built. Saying nothing is the
   * dangerous answer here: `get_trip_progress` would read an empty store and tell the agent "no
   * trip is being generated, call plan_trip_from_reels to start one", which is an invitation to
   * pay for the same trip twice. `unknown` already means exactly what is true — the page lifts
   * its wait screen with a reason, and the agent is sent to look rather than to restart.
   *
   * It takes no lock: nothing is watching this run, so it must not block the next one. And it is
   * silent once a NEWER reservation exists, because that one legitimately owns both views.
   */
  const orphanRun = useCallback((runId: number, tripId: string) => {
    if (deadRef.current || activeRef.current !== runId) return
    setRun({ runId, tripId, status: 'unknown', events: [] })
    // Through the store's own API rather than a new one: we started watching this run and stopped
    // in the same breath, which is precisely what happened. `stop()` owns the wording.
    storeRef.current.start(tripId, () => ({ cancel: () => {} }))
    storeRef.current.stop()
  }, [])

  const reserve = useCallback((): RunReservation | null => {
    // Taken, not read. Two clicks in one tick, or a manual click racing an agent approval, must
    // not both get past here — and the loser has to find out BEFORE it creates a backend job.
    if (deadRef.current || busyRef.current) return null
    busyRef.current = true
    const runId = activeRef.current + 1
    activeRef.current = runId
    // begin() and release() are the two ends of one reservation; whichever lands first wins. A
    // second call is a caller bug (a POST that both threw and returned), and answering it by
    // opening a stream for a lock somebody else now holds is the worst available reply.
    //
    // THREE ways to settle, not two, and `expired` has to stay distinguishable: a release means
    // the caller knows no job exists, an expiry means the caller never said either way.
    let settled: 'begin' | 'release' | 'expired' | null = null

    const give = () => { if (activeRef.current === runId) busyRef.current = false }

    // The lock must not depend on a caller ever coming back. See RESERVATION_DEADLINE_MS.
    const deadline = setTimeout(() => {
      if (settled) return
      settled = 'expired'
      give()
    }, RESERVATION_DEADLINE_MS)

    return {
      begin: (tripId: string) => {
        // Late, on a lock this reservation no longer holds. Opening the stream anyway would put a
        // run on screen that owns nothing — and a manual click in the same window would then be
        // the second paid generation this whole mechanism exists to prevent. Orphaned and said
        // so, rather than silently double-running.
        if (settled === 'expired') { orphanRun(runId, tripId); return }
        if (settled) return
        settled = 'begin'
        clearTimeout(deadline)
        // The reservation is held across an awaited POST, so the shell can have unmounted since.
        if (deadRef.current) { give(); return }
        try {
          beginRun(runId, tripId)
        } catch (err) {
          // `settled` is already set, so the caller's catch will find release() disabled — the
          // lock has to come back HERE or it never does. The error still reaches the caller: a
          // throw out of beginRun is a real bug and swallowing it would hide one.
          give()
          throw err
        }
      },
      release: () => {
        if (settled) return
        settled = 'release'
        clearTimeout(deadline)
        give()
      },
    }
  }, [beginRun, orphanRun])

  const value = useMemo<GenerationApi>(
    () => ({ run, reserve, store: storeRef.current }),
    [run, reserve],
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
