import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, submitTripFeedback } from '@/lib/trip/api'
import type { TripFeedbackDraft } from '@/lib/trip/api'

// A 201 response echoing a persisted row — submitTripFeedback only touches ok/status/statusText/json().
function okFetch(row: Record<string, unknown> = {}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({
      feedback: {
        id: 'fb-1',
        trip_id: 'trip-1',
        artifact_type: 'trip',
        feedback_type: 'thumbs_up',
        rating: null,
        comment: null,
        ...row,
      },
    }),
  } as Response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
}

async function catchErr(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
    return null
  } catch (e) {
    return e
  }
}

describe('submitTripFeedback (api.ts)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs /trips/:id/feedback with the Bearer header and JSON content type', async () => {
    const fetchMock = okFetch()

    await submitTripFeedback('trip-42', { feedback_type: 'thumbs_up' }, 'jwt-token')

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/trips\/trip-42\/feedback$/),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer jwt-token',
          'Content-Type': 'application/json',
        }),
      }),
    )
  })

  it('serializes EXACTLY the draft keys per variant (extra="forbid" upstream makes padding a 422)', async () => {
    const cases: Array<{ draft: TripFeedbackDraft; keys: string[] }> = [
      { draft: { feedback_type: 'thumbs_up' }, keys: ['feedback_type'] },
      { draft: { feedback_type: 'thumbs_up', comment: 'nice route' }, keys: ['feedback_type', 'comment'] },
      { draft: { feedback_type: 'rating', rating: 4, comment: 'good' }, keys: ['feedback_type', 'rating', 'comment'] },
      { draft: { feedback_type: 'free_text', comment: 'a note' }, keys: ['feedback_type', 'comment'] },
    ]

    for (const { draft, keys } of cases) {
      const fetchMock = okFetch()
      await submitTripFeedback('t', draft, 'jwt')
      const body = bodyOf(fetchMock)
      expect(Object.keys(body)).toEqual(keys)
      if ('rating' in draft) expect(typeof body.rating).toBe('number')
    }
  })

  it('resolves to the parsed TripFeedbackResponse on 201 (the stored row, not the request)', async () => {
    okFetch({ id: 'fb-9', feedback_type: 'rating', rating: 5, comment: 'loved it' })

    const out = await submitTripFeedback('t', { feedback_type: 'rating', rating: 5, comment: 'loved it' }, 'jwt')

    expect(out.feedback).toEqual({
      id: 'fb-9',
      trip_id: 'trip-1',
      artifact_type: 'trip',
      feedback_type: 'rating',
      rating: 5,
      comment: 'loved it',
    })
  })

  it('throws ApiError(429, "rate_limited") on the rate-limit envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        json: async () => ({ error: { code: 'rate_limited', message: 'slow down' } }),
      } as Response),
    )

    const err = await catchErr(submitTripFeedback('t', { feedback_type: 'thumbs_up' }, 'jwt'))

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(429)
    expect((err as ApiError).code).toBe('rate_limited')
  })

  it('falls back to ApiError(status, "unknown", statusText) on a non-JSON body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON')
        },
      } as unknown as Response),
    )

    const err = await catchErr(submitTripFeedback('t', { feedback_type: 'thumbs_up' }, 'jwt'))

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(500)
    expect((err as ApiError).code).toBe('unknown')
    expect((err as ApiError).message).toBe('Internal Server Error')
  })
})
