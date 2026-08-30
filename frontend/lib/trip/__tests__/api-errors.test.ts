import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, generateTrip } from '@/lib/trip/api'
import { ERROR_CODE_TRIAL_EXHAUSTED } from '@/lib/trip/backend-types'
import type { GenerateTripRequest } from '@/lib/trip/backend-types'

const baseReq: GenerateTripRequest = {
  reel_urls: ['https://ig/r1'],
  requested_places: [],
  destination_hint: null,
  start_date: '2026-08-01',
  end_date: '2026-08-02',
  budget_level: null,
  origin_city: null,
  preferences: null,
}

// Minimal Response stand-in — generateTrip only touches ok/status/statusText/json().
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

describe('generateTrip error handling (ApiError envelope)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parses the {error:{code,message}} envelope into ApiError(status, code, message)', async () => {
    stubFetch({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({
        error: { code: 'trial_exhausted', message: 'Your free trip is planned.' },
      }),
    })
    const err = await catchErr(generateTrip(baseReq, 'tok'))
    expect(err).toBeInstanceOf(ApiError)
    const apiErr = err as ApiError
    expect(apiErr.status).toBe(403)
    expect(apiErr.code).toBe('trial_exhausted')
    expect(apiErr.code).toBe(ERROR_CODE_TRIAL_EXHAUSTED) // parity: the FE branch key
    expect(apiErr.message).toBe('Your free trip is planned.')
  })

  it('falls back to ApiError(status, "unknown", statusText) on a non-JSON body (no parse error)', async () => {
    stubFetch({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON')
      },
    })
    const err = await catchErr(generateTrip(baseReq, 'tok'))
    // The SyntaxError must NOT leak — a malformed error page becomes a clean ApiError.
    expect(err).toBeInstanceOf(ApiError)
    expect(err).not.toBeInstanceOf(SyntaxError)
    const apiErr = err as ApiError
    expect(apiErr.status).toBe(502)
    expect(apiErr.code).toBe('unknown')
    expect(apiErr.message).toBe('Bad Gateway')
  })

  it('falls back to "unknown" when the JSON body does not match the envelope shape', async () => {
    stubFetch({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ detail: 'something else' }),
    })
    const err = await catchErr(generateTrip(baseReq, 'tok'))
    expect(err).toBeInstanceOf(ApiError)
    const apiErr = err as ApiError
    expect(apiErr.code).toBe('unknown')
    expect(apiErr.message).toBe('Internal Server Error')
  })

  it('existing callers now get the real backend message, not the old "generate-trip failed: <raw>" string', async () => {
    stubFetch({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      json: async () => ({
        error: { code: 'rate_limited', message: 'You have reached today’s limit.' },
      }),
    })
    const err = await catchErr(generateTrip(baseReq, 'tok'))
    const apiErr = err as ApiError
    expect(apiErr.message).toBe('You have reached today’s limit.')
    expect(apiErr.message).not.toContain('generate-trip failed')
  })

  it('returns the parsed body on an ok response', async () => {
    stubFetch({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ trip_id: 'trip-1' }),
    })
    await expect(generateTrip(baseReq, 'tok')).resolves.toEqual({ trip_id: 'trip-1' })
  })
})

/**
 * The rewrite call is the one fetch in the app whose promise is HELD, so it needs a bound.
 *
 * `GlobalTools` keeps the in-flight replan per trip so a second edit does not buy a second
 * narration. That map is only ever cleared when the call settles, so a fetch that never settles
 * does not merely lose one rewrite: every later edit is handed the dead promise, told the
 * summaries are being rewritten, and never triggers another. The trip's prose would be frozen for
 * the rest of the session while the UI insisted it was updating. A timeout turns that into an
 * honest failure the rail can show.
 */
describe('replanTrip is bounded', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  /** A fetch that hangs until its caller aborts it, which is what a wedged backend looks like. */
  function hangingFetch() {
    const mock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted', 'AbortError')),
          )
        }),
    )
    vi.stubGlobal('fetch', mock)
    return mock
  }

  it('gives up rather than hanging forever', async () => {
    vi.useFakeTimers()
    hangingFetch()
    const { replanTrip } = await import('@/lib/trip/api')
    const call = catchErr(replanTrip('trip-1', 'token'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect((await call as Error).message).toMatch(/took too long/i)
  })

  it('says the trip itself is unchanged, because it is', async () => {
    /* The abort's own message is "The operation was aborted", which tells the user nothing about
       what was attempted or whether their edit survived. The edit is already persisted — only
       the narration timed out. */
    vi.useFakeTimers()
    hangingFetch()
    const { replanTrip } = await import('@/lib/trip/api')
    const call = catchErr(replanTrip('trip-1', 'token'))
    await vi.advanceTimersByTimeAsync(120_000)
    const message = (await call as Error).message
    expect(message).toContain('The trip itself is unchanged')
    expect(message).not.toContain('operation was aborted')
  })

  it('does not wait the full timeout before failing on an ordinary refusal', async () => {
    // The bound must not swallow the backend's own error, which is the useful one.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 409, statusText: 'Conflict',
      json: async () => ({ error: { code: 'trip_not_editable', message: 'This trip cannot be edited right now.' } }),
    } as Response))
    const { replanTrip } = await import('@/lib/trip/api')
    const err = await catchErr(replanTrip('trip-1', 'token')) as Error
    expect(err.message).toContain('cannot be edited')
    expect(err.message).not.toMatch(/took too long/i)
  })

  it('cancels its own timer when the call lands, so nothing is left ticking', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ days_narrated: 3, routes_refreshed: true }),
    } as Response))
    const { replanTrip } = await import('@/lib/trip/api')
    await replanTrip('trip-1', 'token')
    expect(vi.getTimerCount()).toBe(0)
  })
})
