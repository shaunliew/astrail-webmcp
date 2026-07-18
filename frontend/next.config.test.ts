import { describe, expect, it } from 'vitest'

import nextConfig from './next.config'

describe('production security headers', () => {
  it('allows the narrow WebAssembly evaluation required by Mapbox Standard and 3D', async () => {
    const routes = await nextConfig.headers?.()
    const csp = routes?.[0]?.headers.find((header) => header.key === 'Content-Security-Policy')?.value

    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'")
  })
})
