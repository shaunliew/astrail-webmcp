/**
 * The channel from an agent action to the page that shows its result.
 *
 * `save_reels` wrote to the database and returned; `plan_trip_from_reels` opened the stream the
 * wait screen renders from. Both left the browser exactly where it was, so from /app/settings the
 * agent reported success while the screen sat still — a chat bot with extra steps. A user who
 * saves a reel lands in their library; the agent's version has to do the same, or the claim that
 * an agent action is indistinguishable from a user action is not true.
 *
 * Deliberately OUTSIDE React. The page that consumes an intent is, by definition, not mounted
 * when the intent is raised — that IS the problem — so it has to survive the remount a route
 * change forces. A provider would work only because it happens to sit above the route; a module
 * says what is actually true, and is testable without a DOM.
 *
 * The rules this file enforces, all of them about NOT navigating:
 *
 * - **Caused, never observed.** An intent exists only because a tool's `execute` created one this
 *   turn. Nothing here watches state, so no background event can move the page.
 * - **Single use.** `takeViewIntent` clears in the same call. A back-button return remounts the
 *   page and takes again; a replayed intent would yank the user out of what they came back to.
 * - **One at a time.** A second action supersedes the first and releases its waiter, rather than
 *   queueing a move the user will have stopped expecting by the time it lands.
 * - **Bounded.** An intent nobody takes is dropped at the deadline, so it cannot be applied by a
 *   page that mounts minutes later — and the tool awaiting it is never left hanging.
 *
 * Module-level state and SSR: an intent is only ever written from a browser event handler (a tool
 * call), never during render, so a server pass has nothing in here to leak between requests.
 */

/** Why the page was moved. Carried, not branched on — it is what tells a save from a generation
 *  in a failing test, and what a visible record of agent actions would print. */
export type ViewReason = 'saved-reels' | 'trip-generation'

/**
 * The one route an agent action sends the app to.
 *
 * Both reasons land here because both results are visible here: `/app` is the saved-reel library,
 * and it is where SavedReelsFlow swaps in the wait screen for an active run, whoever started it.
 */
export const AGENT_VIEW_ROUTE = '/app'

/**
 * How long a tool waits for the page to arrive before giving up on it.
 *
 * This bounds a tool call, so it is short: `plan_trip_from_reels` promises to return in about a
 * second, and a client-side route change is tens of milliseconds. It only ever elapses when there
 * is no consumer at all — the mock-auth shell renders CreateTripFlow at `/app` instead — and the
 * honest outcome there is a tool that resolves a beat late, not one that never resolves.
 */
export const VIEW_INTENT_TIMEOUT_MS = 3_000

export type ViewIntent = {
  /** Increments per intent, so a test (and a reader) can tell one from a replay of it. */
  id: number
  reason: ViewReason
}

type Pending = {
  intent: ViewIntent
  /** Releases whoever is awaiting the page move. Called exactly once per intent. */
  settle: () => void
  timer: ReturnType<typeof setTimeout>
}

let pending: Pending | null = null
let seq = 0
const listeners = new Set<() => void>()

/** Removes the pending intent and stops its deadline, returning it so the caller can settle it. */
function detach(): Pending | null {
  const current = pending
  if (!current) return null
  pending = null
  clearTimeout(current.timer)
  return current
}

/**
 * Ask the app to show where an action's result is visible.
 *
 * Returns the intent plus a promise that settles once a page has taken it — which is what a tool
 * awaits so it cannot report success while the screen is still on the old route. It settles on
 * the deadline too: a tool that hangs is worse than one that moved nothing.
 */
export function requestViewIntent(reason: ViewReason): { intent: ViewIntent; settled: Promise<void> } {
  // Whoever was waiting is released rather than left holding a move that now belongs to a newer
  // action. Nothing is queued: only the newest intent is on offer.
  detach()?.settle()

  const intent: ViewIntent = { id: ++seq, reason }
  let settle!: () => void
  const settled = new Promise<void>((resolve) => { settle = resolve })

  const timer = setTimeout(() => {
    // Guarded on identity: a newer intent has its own deadline, and this one must not cancel it.
    if (pending?.intent.id !== intent.id) return
    pending = null
    settle()
  }, VIEW_INTENT_TIMEOUT_MS)

  pending = { intent, settle, timer }
  // A copy, so a listener that unsubscribes while being told cannot skip the next one.
  for (const listener of [...listeners]) listener()
  return { intent, settled }
}

/**
 * Take the intent waiting for this page, if there is one.
 *
 * Taking IS the acknowledgement: it releases the tool that raised it. That happens in the
 * consumer's mount effect, which React runs after the route change has already been committed and
 * painted — so by the time this settles, the page the user is looking at really has moved.
 */
export function takeViewIntent(): ViewIntent | null {
  const current = detach()
  if (!current) return null
  current.settle()
  return current.intent
}

/** Told when an intent is raised, so a page already on screen applies it without a remount. */
export function subscribeViewIntent(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Test-only reset. Settles anything pending so no test can leave a promise hanging into another. */
export function resetViewIntent(): void {
  detach()?.settle()
}
