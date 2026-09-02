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

  /* A pasted URL keeps its trailing slash, and every caller composes `${base}/path`. So
     "https://host/" becomes "https://host//path", which FastAPI 404s rather than collapsing —
     measured against the live deployment on 2026-09-02, where it turned every backend call into
     a not-found while the page still loaded and the tools still registered.

     Copying a URL out of a browser address bar includes that slash more often than not, and the
     resulting failure is indistinguishable from a broken integration. Cheaper to absorb here
     than to document. */
  it('strips a trailing slash, so callers cannot build a double-slash URL', () => {
    vi.stubEnv('NEXT_PUBLIC_BACKEND_URL', 'https://astrail-webmcp-api.onrender.com/')
    expect(resolveBackendUrl()).toBe('https://astrail-webmcp-api.onrender.com')
  })

  it('strips several, and whitespace around them', () => {
    vi.stubEnv('NEXT_PUBLIC_BACKEND_URL', '  https://api.example.com///  ')
    expect(resolveBackendUrl()).toBe('https://api.example.com')
  })

  it('leaves a clean URL exactly as configured', () => {
    vi.stubEnv('NEXT_PUBLIC_BACKEND_URL', 'https://api.example.com')
    expect(resolveBackendUrl()).toBe('https://api.example.com')
  })

  it('still treats a slash-only value as unset rather than as a host', () => {
    // "/" trims to "" — falsy, so the production guard fires instead of shipping "" as a base.
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('NEXT_PUBLIC_BACKEND_URL', '/')
    expect(() => resolveBackendUrl()).toThrow(/required in production/)
  })
})
