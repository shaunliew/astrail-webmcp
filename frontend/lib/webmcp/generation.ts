import type { GenerationStage, StreamEvent } from '@/lib/trip/backend-types'

/**
 * Generation state, owned OUTSIDE any tool call.
 *
 * A trip takes 60-180 seconds. A WebMCP `execute()` cannot block that long — the agent would sit
 * dead and the user would watch a spinner with no narration. So the tool that STARTS a generation
 * returns in about a second, and the stream lives here instead, for three reasons:
 *
 *   1. The tool call ends long before the stream does.
 *   2. The same store drives the on-screen progress, so chat and page can never disagree
 *      about which stage is running.
 *   3. If the agent disconnects or the user navigates, the trip still lands — the job is
 *      durable server-side regardless.
 */

/** Ordered for progress reporting. `cache_hit` is optional and never counted as a step. */
export const STAGE_ORDER: GenerationStage[] = [
  'create_trip', 'preferences', 'scrape', 'extract', 'resolve', 'dedup',
  'enrich', 'weather', 'transport', 'restaurants', 'hotels', 'narrate', 'summarize', 'save',
]

export type GenerationStatus = 'generating' | 'complete' | 'failed' | 'unknown'

export type GenerationSnapshot = {
  tripId: string
  status: GenerationStatus
  elapsedS: number
  stagesSeen: number
  totalStages: number
  /** Raw stage id; the caller maps it through STAGE_LABEL so chat matches the screen. */
  stage: GenerationStage | null
  /** Latest decision/warning message — what makes a poll a narration beat rather than a repeat. */
  lastMessage: string | null
  /** Increments on every meaningful change. The throttle compares this, not wall-clock alone. */
  version: number
}

type Waiter = { resolve: () => void; timer: ReturnType<typeof setTimeout> }

/** What a terminal `result` frame actually says. Three answers, because there are three. */
export type ResultVerdict = 'success' | 'failed' | 'unreadable'

/**
 * Read a terminal result frame.
 *
 * A leased backend failure emits a `result` whose payload carries `{error: …}` and NO preceding
 * `error` event (pipeline/runner.py:181 → api/streaming.py:60). Success carries `{itinerary: …}`
 * (runner.py:654). This rule lives here, next to the status it decides, so every consumer of the
 * store agrees: reading it only in the page left the screen saying failed while get_trip_progress
 * told the agent "the trip is ready".
 *
 * Two things it deliberately does NOT do:
 *
 *   - It does not test the error's TRUTHINESS. `{"error": null}`, `{"error": ""}` and
 *     `{"error": false}` are failure frames that lost their message; `Boolean(parsed.error)`
 *     called every one of them a finished trip.
 *   - It does not report a payload it could not read as either outcome. Unreadable is not
 *     evidence of a dead trip — calling it one sends the user to pay for a second generation of
 *     a trip they already have — and it is not evidence of a live one either. `unreadable` maps
 *     to `unknown`, which points the user at the page instead of asserting anything.
 */
export function readResultVerdict(content: string): ResultVerdict {
  let payload: unknown
  try {
    payload = JSON.parse(content)
  } catch {
    return 'unreadable'
  }
  // `null`, `42`, `"done"` and `[…]` all parse, and `.error` is undefined on every one of them,
  // so a truthiness test read them all as a completed trip. None is a result frame.
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return 'unreadable'
  return 'error' in payload ? 'failed' : 'success'
}

/** The status a terminal result puts the run into. One mapping, so no consumer invents its own. */
export function statusFromResult(content: string): GenerationStatus {
  const verdict = readResultVerdict(content)
  if (verdict === 'failed') return 'failed'
  if (verdict === 'unreadable') return 'unknown'
  return 'complete'
}

export type GenerationStore = ReturnType<typeof createGenerationStore>

export function createGenerationStore(now: () => number = Date.now) {
  let snap: GenerationSnapshot | null = null
  let cancelStream: (() => void) | null = null
  let startedAt = 0
  const seen = new Set<GenerationStage>()
  const waiters = new Set<Waiter>()
  const listeners = new Set<() => void>()

  const bump = (patch: Partial<GenerationSnapshot>) => {
    if (!snap) return
    snap = { ...snap, ...patch, version: snap.version + 1, elapsedS: Math.round((now() - startedAt) / 1000) }
    for (const w of waiters) { clearTimeout(w.timer); w.resolve() }
    waiters.clear()
    for (const l of listeners) l()
  }

  const onEvent = (e: StreamEvent) => {
    if (e.type === 'result') { bump({ status: statusFromResult(e.content) }); return }
    if (e.type === 'heartbeat') { bump({}); return }
    if (e.type === 'error') { bump({ status: 'failed', stage: e.stage, lastMessage: e.msg }); return }
    if (e.type === 'stage') {
      if (e.stage !== 'cache_hit') seen.add(e.stage)
      bump({ stage: e.stage, lastMessage: e.msg, stagesSeen: seen.size })
      return
    }
    // decision | warning — the substance an agent can actually narrate.
    //
    // `stage` is deliberately NOT updated. The late pipeline stages run concurrently and each
    // reports its own completion, so these arrive for a stage that has FINISHED while others are
    // still working. get_trip_progress presents `stage` to the agent as the stage now running;
    // letting a finished one overwrite it makes the agent announce the wrong live stage, and
    // yields self-contradictions like `stage "Writing your day summaries" · last: Wrote summaries
    // for 3 days`. The message carries the news; the stage field stays the last thing STARTED.
    bump({ lastMessage: e.msg })
  }

  return {
    /** `open` returns a cancel handle; injected so tests need no EventSource. */
    start(tripId: string, open: (onEvent: (e: StreamEvent) => void, onFail: () => void) => { cancel: () => void }) {
      cancelStream?.()
      seen.clear()
      startedAt = now()
      snap = {
        tripId, status: 'generating', elapsedS: 0, stagesSeen: 0,
        totalStages: STAGE_ORDER.length, stage: null, lastMessage: null, version: 0,
      }
      // A dead backend must never mean an eternal "generating" — `unknown` sends the agent to
      // the page instead of letting it poll forever against a stream that will never advance.
      const handle = open(onEvent, () => bump({ status: 'unknown' }))
      cancelStream = handle.cancel
      for (const l of listeners) l()
    },

    snapshot(): GenerationSnapshot | null {
      if (!snap) return null
      return { ...snap, elapsedS: Math.round((now() - startedAt) / 1000) }
    },

    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },

    /**
     * Resolve when the run advances past `sinceVersion`, or after `timeoutMs`.
     *
     * This is what stops an eager agent hammering the tool: rather than returning the same
     * string instantly, the call simply takes a moment. A 15s wait sits safely inside any
     * plausible tool timeout; blocking for the full 180s would not.
     */
    waitForAdvance(sinceVersion: number, timeoutMs: number): Promise<void> {
      if (!snap || snap.version !== sinceVersion || snap.status !== 'generating') return Promise.resolve()
      return new Promise<void>((resolve) => {
        const w: Waiter = { resolve, timer: setTimeout(() => { waiters.delete(w); resolve() }, timeoutMs) }
        waiters.add(w)
      })
    },

    /**
     * Stop watching this run.
     *
     * The status goes to `unknown`, not to nothing and not to a lingering `generating`. Leaving it
     * `generating` made stop() inconsistent with itself — it handed the run lock back while both
     * views still said a run was in progress, so get_trip_progress answered "generating" for a
     * stream nobody was reading and the page kept the wait screen up with nothing behind it.
     * `unknown` is the honest word: the durable job may well still land.
     */
    stop() {
      cancelStream?.()
      cancelStream = null
      // Only a run still IN PROGRESS is downgraded. A run that already reached a verdict keeps
      // it — flipping a finished trip to 'unknown' on the way out would make this store disagree
      // with the React run the page renders, which is the exact split the shell exists to close.
      if (snap?.status === 'generating') bump({ status: 'unknown' })
      // Belt to bump()'s braces: bump is a no-op before a run has started, and a waiter must
      // never be left holding a tool call open.
      for (const w of waiters) { clearTimeout(w.timer); w.resolve() }
      waiters.clear()
    },
  }
}
