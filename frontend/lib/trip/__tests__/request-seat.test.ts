import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, requestSeat } from '@/lib/trip/api'

// Minimal Response stand-in — requestSeat only touches ok/status/statusText/json().
function stubFetch(res: Partial<Response>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res as Response))
}

async function catchErr(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
    return null
  } catch (e) {
    return e
  }
}

describe('requestSeat (api.ts)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs /request-seat with the Bearer header (no body) and returns the parsed stamp', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ requested_at: '2026-08-03T09:00:00.000Z' }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const out = await requestSeat('jwt-token')

    expect(out).toEqual({ requested_at: '2026-08-03T09:00:00.000Z' })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/request-seat$/),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer jwt-token' }),
      }),
    )
    // Idempotent seat request carries no request body (backend reads identity from the token).
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('body')
  })

  it('throws an ApiError (envelope-parsed) on a non-ok response', async () => {
    stubFetch({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({ error: { code: 'identity_unavailable', message: 'no users row' } }),
    })

    const err = await catchErr(requestSeat('jwt-token'))

    expect(err).toBeInstanceOf(ApiError)
    const apiErr = err as ApiError
    expect(apiErr.status).toBe(503)
    expect(apiErr.code).toBe('identity_unavailable')
    expect(apiErr.message).toBe('no users row')
  })

  it('falls back to ApiError(status, "unknown", statusText) on a non-JSON error body', async () => {
    stubFetch({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => {
        throw new SyntaxError('Unexpected token <')
      },
    })

    const err = await catchErr(requestSeat('jwt-token'))

    expect(err).toBeInstanceOf(ApiError)
    expect(err).not.toBeInstanceOf(SyntaxError)
    expect((err as ApiError).code).toBe('unknown')
  })
})
