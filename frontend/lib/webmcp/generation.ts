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
    if (e.type === 'result') { bump({ status: 'complete' }); return }
    if (e.type === 'heartbeat') { bump({}); return }
    if (e.type === 'error') { bump({ status: 'failed', stage: e.stage, lastMessage: e.msg }); return }
    if (e.type === 'stage') {
      if (e.stage !== 'cache_hit') seen.add(e.stage)
      bump({ stage: e.stage, lastMessage: e.msg, stagesSeen: seen.size })
      return
    }
    // decision | warning — the substance an agent can actually narrate.
    bump({ lastMessage: e.msg, stage: e.stage })
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

    stop() {
      cancelStream?.()
      cancelStream = null
      for (const w of waiters) { clearTimeout(w.timer); w.resolve() }
      waiters.clear()
    },
  }
}
