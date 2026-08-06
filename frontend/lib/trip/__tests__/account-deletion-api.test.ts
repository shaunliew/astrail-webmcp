import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  cancelAccountDeletion,
  getAccountDeletionStatus,
  requestAccountDeletion,
} from '@/lib/trip/api'

// Minimal Response stand-in — both functions only touch ok/status/statusText/json().
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

describe('requestAccountDeletion (api.ts)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs /account/deletion with the Bearer header (no body) and returns the parsed schedule', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ scheduled_for: '2026-08-11T09:00:00.000Z' }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const out = await requestAccountDeletion('jwt-token')

    expect(out).toEqual({ scheduled_for: '2026-08-11T09:00:00.000Z' })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/account\/deletion$/),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer jwt-token' }),
      }),
    )
    // Self-serve delete carries no request body — the backend reads identity from the token
    // (never a client-supplied user id: guardrails #5/#6).
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('body')
  })

  it('throws ApiError(503, "deletion_unavailable") when the feature is gated off', async () => {
    stubFetch({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({ error: { code: 'deletion_unavailable', message: 'not available yet' } }),
    })

    const err = await catchErr(requestAccountDeletion('jwt-token'))

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(503)
    expect((err as ApiError).code).toBe('deletion_unavailable')
  })

  it('throws ApiError(409, "deletion_not_active") when already pending/deleting', async () => {
    stubFetch({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: async () => ({ error: { code: 'deletion_not_active', message: "can't schedule now" } }),
    })

    const err = await catchErr(requestAccountDeletion('jwt-token'))

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(409)
    expect((err as ApiError).code).toBe('deletion_not_active')
  })
})

describe('cancelAccountDeletion (api.ts)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('POSTs /account/deletion/cancel with the Bearer header (no body) and returns {cancelled:true}', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ cancelled: true }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const out = await cancelAccountDeletion('jwt-token')

    expect(out).toEqual({ cancelled: true })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/account\/deletion\/cancel$/),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer jwt-token' }),
      }),
    )
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('body')
  })

  it('throws ApiError(409, "deletion_already_started") once the sweeper has claimed the account', async () => {
    stubFetch({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: async () => ({ error: { code: 'deletion_already_started', message: 'already started' } }),
    })

    const err = await catchErr(cancelAccountDeletion('jwt-token'))

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(409)
    expect((err as ApiError).code).toBe('deletion_already_started')
  })
})

describe('getAccountDeletionStatus (api.ts)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('GETs /account/deletion/status with the Bearer header (no body) and returns the parsed status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ account_status: 'pending_deletion', deletion_scheduled_for: '2026-08-11T09:00:00.000Z' }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)

    const out = await getAccountDeletionStatus('jwt-token')

    expect(out).toEqual({ account_status: 'pending_deletion', deletion_scheduled_for: '2026-08-11T09:00:00.000Z' })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/account\/deletion\/status$/),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer jwt-token' }),
      }),
    )
    // Cross-session read carries no request body — identity is the token (guardrails #5/#6).
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('body')
  })

  it('propagates a non-ok response as an ApiError (the caller fails safe to the active default)', async () => {
    stubFetch({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({ error: { code: 'deletion_unavailable', message: 'not available yet' } }),
    })

    const err = await catchErr(getAccountDeletionStatus('jwt-token'))

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(503)
    expect((err as ApiError).code).toBe('deletion_unavailable')
  })
})
