import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveBackendUrl } from '@/lib/backend-url'

describe('resolveBackendUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('falls back to localhost in local development when the var is unset', () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('NEXT_PUBLIC_BACKEND_URL', undefined)

    expect(resolveBackendUrl()).toBe('http://localhost:8000')
  })

  it('throws in production when the var is unset', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_BACKEND_URL', undefined)

    expect(() => resolveBackendUrl()).toThrow('NEXT_PUBLIC_BACKEND_URL is required in production')
  })

  it('throws in production when the var is empty or whitespace-only', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_BACKEND_URL', '   ')

    expect(() => resolveBackendUrl()).toThrow('NEXT_PUBLIC_BACKEND_URL is required in production')
  })

  it('returns the configured URL in production when set', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_BACKEND_URL', 'https://api.astrail.xyz')

    expect(resolveBackendUrl()).toBe('https://api.astrail.xyz')
  })
})
