/**
 * The organize jobs this browser is following, owned OUTSIDE any page.
 *
 * A job id used to reach the library page through an optional ref that page owned
 * (`WebMcpRegistry.adoptOrganizeJob`), and that is the wrong owner for work which outlives the
 * page. A finished generation navigates to the trip, which unmounts the library while
 * `startOrganize` is still awaiting its response: the ref had already been nulled, so the id was
 * dropped on the floor, and even an id that DID land lived in that page's `useState` and died with
 * it. Coming back to /app then showed "Not analyzed" for a job running perfectly well — the exact
 * complaint the post-generation organize was built to fix.
 *
 * Deliberately a module rather than a provider, for the same reason `lib/webmcp/view-intent.ts` is
 * one: the consumer is BY DEFINITION not mounted when the thing it needs is produced, so ownership
 * cannot sit anywhere a route change can unmount. `GenerationProvider` survives navigation, but a
 * generation is not what this is about — `save_reels` starts organize jobs with no run in sight —
 * and a module is testable without a DOM.
 *
 * What it deliberately does NOT do: persist. A hard reload drops the set, and that is correct —
 * the job is durable server-side, the cards re-read their real status from the database on mount,
 * and a stale id rehydrated from storage would poll a job nobody is waiting for.
 *
 * Module-level state and SSR: everything here is written from a browser event handler (a tool call
 * or a poll tick), never during render, so a server pass has nothing in here to leak.
 */

/**
 * Most jobs followed at once. Real use adds one per `save_reels` call and one per generation; the
 * cap only bites on a job that never reaches a terminal status and so is never retired.
 */
export const MAX_TRACKED_ORGANIZE_JOBS = 8

/** What the user is told when the post-run organize could not be started at all. */
export const ORGANIZE_FAILED_MESSAGE =
  'We could not organize the Reels from your last trip — they are saved, but their places are ' +
  'missing. Select them in your library and organize them again.'

/**
 * The same outcome, reached by a different route: another organize job already held one of these
 * Reels, so the RPC started none of them.
 *
 * Worth its own sentence because the cause changes what the user should think. Nothing broke, and
 * the reels the other job holds WILL be read — it is the rest of the batch that was never started.
 * "Something went wrong" would send them looking for a fault that is not there.
 *
 * Worded to stay true for as long as it is on screen, which is the harder half. It is shown only
 * after every attempt has been refused as an overlap, and by the time anyone reads it that other
 * job has very likely finished — so it says what was true (past tense) and what to do, and claims
 * nothing about the present. The caller earns it by seeing NOTHING but conflicts; a ladder that
 * also hit something else gets ORGANIZE_FAILED_MESSAGE, because this sentence names a cause.
 */
export const ORGANIZE_CONFLICT_MESSAGE =
  'At least one of those Reels was still tied up in another analysis, so none of this batch was ' +
  'started. Open your library, select them, and organize them again.'

export type OrganizeFailure = {
  /** The reels that were never organized, so whoever retries knows what to ask for. */
  savedReelIds: string[]
  /** Why, in the words the user is shown. */
  message: string
}

export type OrganizeJobsSnapshot = {
  jobIds: string[]
  /** The last organize that could not be started, until something clears it. */
  failure: OrganizeFailure | null
}

const EMPTY: OrganizeJobsSnapshot = { jobIds: [], failure: null }

let snapshot: OrganizeJobsSnapshot = EMPTY
const listeners = new Set<() => void>()

/** Swap the snapshot wholesale and tell everyone. New objects only — consumers compare identity. */
function publish(next: OrganizeJobsSnapshot): void {
  snapshot = next
  // A copy, so a listener that unsubscribes while being told cannot skip the next one.
  for (const listener of [...listeners]) listener()
}

/** The jobs being followed right now. Stable by identity while nothing changes. */
export function organizeJobs(): OrganizeJobsSnapshot {
  return snapshot
}

/**
 * Follow a job that has just been created.
 *
 * Called the moment `startOrganize` resolves, from wherever it was called — no ref, no mounted
 * page, nothing to be null. Deliberately does not clear a standing failure: a later, unrelated
 * batch starting is no evidence that the reels which failed were ever read.
 */
export function trackOrganizeJob(jobId: string): void {
  if (snapshot.jobIds.includes(jobId)) return
  // Oldest out at the cap — a stalled job is the least likely to still matter.
  publish({ ...snapshot, jobIds: [...snapshot.jobIds, jobId].slice(-MAX_TRACKED_ORGANIZE_JOBS) })
}

/** Stop following jobs that have reached a terminal status. */
export function retireOrganizeJobs(jobIds: Iterable<string>): void {
  const done = new Set(jobIds)
  const kept = snapshot.jobIds.filter((id) => !done.has(id))
  if (kept.length === snapshot.jobIds.length) return
  publish({ ...snapshot, jobIds: kept })
}

/**
 * Remember an organize that could not be started, so it is not merely swallowed.
 *
 * The trip is built, saved and on screen by the time this happens, and a library write must never
 * resurface as a trip failure (guardrail #3) — but "not a trip failure" is not "nothing happened".
 * Kept here so the library page can say it whenever the user next looks at it, which is the one
 * screen where the missing places are visible.
 */
export function recordOrganizeFailure(failure: OrganizeFailure): void {
  publish({ ...snapshot, failure })
}

/**
 * Drop the standing failure only if `savedReelIds` covers every reel it is about.
 *
 * The identity check is the point. Clearing on any successful organize erased the notice for one
 * run's unorganized reels the moment an unrelated later run succeeded — the reels still had no
 * places, and the one thing that said so was gone. Containment rather than equality: a batch that
 * organizes these reels AND others has still organized these.
 */
export function clearOrganizeFailureFor(savedReelIds: Iterable<string>): void {
  const { failure } = snapshot
  if (!failure) return
  const covered = new Set(savedReelIds)
  if (!failure.savedReelIds.every((id) => covered.has(id))) return
  publish({ ...snapshot, failure: null })
}

/** Drop the standing failure outright — for a caller that has established it no longer holds. */
export function clearOrganizeFailure(): void {
  if (snapshot.failure === null) return
  publish({ ...snapshot, failure: null })
}

/** Told whenever the set or the failure changes, so a mounted page follows a job it did not start. */
export function subscribeOrganizeJobs(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Test-only reset. Module state outlives a test file's renders, so every suite starts clean. */
export function resetOrganizeJobs(): void {
  snapshot = EMPTY
}
