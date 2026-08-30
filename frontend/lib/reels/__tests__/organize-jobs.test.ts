import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_TRACKED_ORGANIZE_JOBS, ORGANIZE_FAILED_MESSAGE, clearOrganizeFailure,
  clearOrganizeFailureFor, organizeJobs, recordOrganizeFailure, resetOrganizeJobs,
  retireOrganizeJobs, subscribeOrganizeJobs, trackOrganizeJob,
} from '../organize-jobs'

/**
 * The organize work that outlives the page that started it.
 *
 * The defect: `startOrganize` was handed to the library page through an optional ref the page
 * owned, and a finished generation navigates away from that page while the request is still in
 * flight. The id landed in a ref that had already been nulled, and even an adopted one lived in
 * that page's state and died with it — so coming back to /app showed "Not analyzed" for a job that
 * was running perfectly well. A module owns it instead, for the same reason `view-intent` is a
 * module: the consumer is by definition not mounted when the thing it needs is produced.
 */

beforeEach(() => { resetOrganizeJobs() })

describe('tracking organize jobs across page unmounts', () => {
  it('starts with nothing tracked and no failure', () => {
    expect(organizeJobs()).toEqual({ jobIds: [], failure: null })
  })

  it('keeps a job that was tracked while nothing was listening', () => {
    // The whole point: no subscriber exists at the moment the id arrives, because the page that
    // wants it is mid-navigation. It has to still be there when one turns up.
    trackOrganizeJob('job-1')
    expect(organizeJobs().jobIds).toEqual(['job-1'])
  })

  it('tracks several jobs, oldest first', () => {
    // Two disjoint batches run side by side server-side — the active unique index is on
    // (user_id, idempotency_key), and creation rejects only an OVERLAPPING batch.
    trackOrganizeJob('job-1')
    trackOrganizeJob('job-2')
    expect(organizeJobs().jobIds).toEqual(['job-1', 'job-2'])
  })

  it('ignores a job it is already following', () => {
    trackOrganizeJob('job-1')
    const before = organizeJobs()
    trackOrganizeJob('job-1')
    // Same VALUE and same identity: a snapshot that changes on a no-op re-renders every consumer.
    expect(organizeJobs()).toBe(before)
  })

  it('drops the oldest once the cap is reached', () => {
    // A job normally retires when it goes terminal. One that never does — deleted, permanently
    // unreadable — would otherwise be polled for the life of the tab and grow the batch forever.
    for (let i = 1; i <= MAX_TRACKED_ORGANIZE_JOBS + 2; i += 1) trackOrganizeJob(`job-${i}`)
    const { jobIds } = organizeJobs()
    expect(jobIds).toHaveLength(MAX_TRACKED_ORGANIZE_JOBS)
    expect(jobIds).not.toContain('job-1')
    expect(jobIds).not.toContain('job-2')
    expect(jobIds).toContain('job-3')
    expect(jobIds).toContain(`job-${MAX_TRACKED_ORGANIZE_JOBS + 2}`)
  })

  it('retires the jobs it is given and leaves the rest', () => {
    trackOrganizeJob('job-1')
    trackOrganizeJob('job-2')
    retireOrganizeJobs(['job-1'])
    expect(organizeJobs().jobIds).toEqual(['job-2'])
  })

  it('does not churn the snapshot when retiring a job it never had', () => {
    trackOrganizeJob('job-1')
    const before = organizeJobs()
    retireOrganizeJobs(['job-nobody'])
    expect(organizeJobs()).toBe(before)
  })

  it('tells subscribers when a job arrives, and stops when they leave', () => {
    const heard = vi.fn()
    const unsubscribe = subscribeOrganizeJobs(heard)
    trackOrganizeJob('job-1')
    expect(heard).toHaveBeenCalledTimes(1)
    unsubscribe()
    trackOrganizeJob('job-2')
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('does not tell subscribers about a no-op', () => {
    trackOrganizeJob('job-1')
    const heard = vi.fn()
    subscribeOrganizeJobs(heard)
    trackOrganizeJob('job-1')
    retireOrganizeJobs(['job-nobody'])
    expect(heard).not.toHaveBeenCalled()
  })
})

describe('a failed organize, kept where someone can see it', () => {
  it('holds the reels that were never organized, and says so', () => {
    // Swallowed was the old behaviour and it is the one outcome that must not survive: a library
    // write must not surface as a trip failure (guardrail #3), but it must not look like success.
    recordOrganizeFailure({ savedReelIds: ['reel-1', 'reel-2'], message: ORGANIZE_FAILED_MESSAGE })
    expect(organizeJobs().failure).toEqual({
      savedReelIds: ['reel-1', 'reel-2'], message: ORGANIZE_FAILED_MESSAGE,
    })
  })

  it('tells subscribers about a failure and about clearing one', () => {
    const heard = vi.fn()
    subscribeOrganizeJobs(heard)
    recordOrganizeFailure({ savedReelIds: ['reel-1'], message: ORGANIZE_FAILED_MESSAGE })
    expect(heard).toHaveBeenCalledTimes(1)
    clearOrganizeFailure()
    expect(organizeJobs().failure).toBeNull()
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('does not churn the snapshot when clearing a failure that is not there', () => {
    const before = organizeJobs()
    clearOrganizeFailure()
    expect(organizeJobs()).toBe(before)
  })

  it('clears only for a batch that covers every reel it names', () => {
    /* The identity check. `clearOrganizeFailure()` used to fire on ANY successful organize, so an
       unrelated later run erased the notice for reels that still had no places. */
    recordOrganizeFailure({ savedReelIds: ['reel-1', 'reel-2'], message: ORGANIZE_FAILED_MESSAGE })

    clearOrganizeFailureFor(['reel-1'])                      // half of them is not all of them
    expect(organizeJobs().failure).not.toBeNull()
    clearOrganizeFailureFor(['reel-elsewhere'])              // none of them
    expect(organizeJobs().failure).not.toBeNull()

    clearOrganizeFailureFor(['reel-1', 'reel-2', 'reel-3'])  // covers them, plus others
    expect(organizeJobs().failure).toBeNull()
  })

  it('does not churn the snapshot when the batch does not cover the failure', () => {
    recordOrganizeFailure({ savedReelIds: ['reel-1'], message: ORGANIZE_FAILED_MESSAGE })
    const before = organizeJobs()
    clearOrganizeFailureFor(['reel-elsewhere'])
    expect(organizeJobs()).toBe(before)
  })

  it('keeps the failure while jobs come and go', () => {
    // A later, unrelated save_reels organize is no evidence that these reels were read.
    recordOrganizeFailure({ savedReelIds: ['reel-1'], message: ORGANIZE_FAILED_MESSAGE })
    trackOrganizeJob('job-9')
    expect(organizeJobs().failure?.savedReelIds).toEqual(['reel-1'])
  })
})
