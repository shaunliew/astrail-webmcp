import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Force the mock-auth demo shell for this whole file. Under it there is no backend and the token
// is fake, so submitTripFeedback must resolve to the deterministic persisted-row shape WITHOUT any
// network call (mirrors requestSeat / the deletion fns). vi.mock is hoisted, so the import below
// sees it enabled.
vi.mock('@/lib/auth/mock-auth', () => ({ MOCK_AUTH_ENABLED: true }))

import { submitTripFeedback } from '@/lib/trip/api'

describe('submitTripFeedback under MOCK_AUTH_ENABLED', () => {
  beforeEach(() => {
    // Any real network call is a bug in the short-circuit — spy so we can assert it never fires.
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves to the deterministic row echoing trip_id/type/rating/comment, no network', async () => {
    const out = await submitTripFeedback(
      'trip-77',
      { feedback_type: 'rating', rating: 3, comment: 'ok' },
      'fake-token',
    )
    expect(out).toEqual({
      feedback: {
        id: 'mock-feedback-1',
        trip_id: 'trip-77',
        artifact_type: 'trip',
        feedback_type: 'rating',
        rating: 3,
        comment: 'ok',
      },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('echoes a bare thumbs draft with null rating and comment, still no network', async () => {
    const out = await submitTripFeedback('trip-77', { feedback_type: 'thumbs_down' }, 'fake-token')
    expect(out.feedback).toEqual({
      id: 'mock-feedback-1',
      trip_id: 'trip-77',
      artifact_type: 'trip',
      feedback_type: 'thumbs_down',
      rating: null,
      comment: null,
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
