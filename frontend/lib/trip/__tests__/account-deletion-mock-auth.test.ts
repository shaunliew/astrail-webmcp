import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Force the mock-auth demo shell for this whole file. Under it there is no backend and the token is
// fake, so the deletion api fns must short-circuit to sensible mock values WITHOUT any network call
// (mirrors generateTrip / requestSeat). vi.mock is hoisted, so every import below sees it enabled.
vi.mock('@/lib/auth/mock-auth', () => ({ MOCK_AUTH_ENABLED: true }))

import {
  cancelAccountDeletion,
  getAccountDeletionStatus,
  requestAccountDeletion,
} from '@/lib/trip/api'

describe('account-deletion api under MOCK_AUTH_ENABLED', () => {
  beforeEach(() => {
    // Any real network call is a bug in the short-circuit — spy so we can assert it never fires.
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('getAccountDeletionStatus returns a benign active state without hitting the network', async () => {
    const out = await getAccountDeletionStatus('fake-token')
    expect(out).toEqual({ account_status: 'active', deletion_scheduled_for: null })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('requestAccountDeletion returns a deterministic mock schedule without hitting the network', async () => {
    const out = await requestAccountDeletion('fake-token')
    expect(typeof out.scheduled_for).toBe('string')
    expect(out.scheduled_for.length).toBeGreaterThan(0)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('cancelAccountDeletion returns a mock success without hitting the network', async () => {
    const out = await cancelAccountDeletion('fake-token')
    expect(out).toEqual({ cancelled: true })
    expect(fetch).not.toHaveBeenCalled()
  })
})
