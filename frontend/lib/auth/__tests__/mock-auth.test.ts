import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('mock-auth', () => {
  beforeEach(() => { vi.resetModules() })
  afterEach(() => { delete process.env.NEXT_PUBLIC_MOCK_AUTH })

  it('is disabled by default (no session)', async () => {
    const { MOCK_AUTH_ENABLED, getMockSession } = await import('@/lib/auth/mock-auth')
    expect(MOCK_AUTH_ENABLED).toBe(false)
    expect(getMockSession()).toBeNull()
  })

  it('returns a demo session when the flag is on', async () => {
    process.env.NEXT_PUBLIC_MOCK_AUTH = 'true'
    vi.resetModules()
    const { MOCK_AUTH_ENABLED, getMockSession, MOCK_USER } = await import('@/lib/auth/mock-auth')
    expect(MOCK_AUTH_ENABLED).toBe(true)
    expect(getMockSession()?.user.id).toBe(MOCK_USER.id)
    expect(MOCK_USER.id).toBe('demo-user')
  })
})
