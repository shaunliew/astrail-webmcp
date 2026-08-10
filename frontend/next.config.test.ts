import { describe, expect, it } from 'vitest'

import nextConfig from './next.config'

describe('production security headers', () => {
  it('allows the narrow WebAssembly evaluation required by Mapbox Standard and 3D', async () => {
    const routes = await nextConfig.headers?.()
    const csp = routes?.[0]?.headers.find((header) => header.key === 'Content-Security-Policy')?.value

    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'")
    expect(csp).toContain('https://*.cdninstagram.com')
    expect(csp).toContain('https://*.fbcdn.net')
    expect(csp).toContain('https://*.ingest.sentry.io')
    expect(csp).toContain('https://*.ingest.us.sentry.io')
    expect(csp).toContain('https://*.ingest.de.sentry.io')

    // Re-hosted reel covers live in Supabase Storage — img-src must allow the host or every cover is CSP-blocked.
    const imgSrc = csp?.split('; ').find((directive) => directive.startsWith('img-src'))
    expect(imgSrc).toContain('supabase.co')
  })
})
