import { describe, it, expect } from 'vitest'

describe('test harness', () => {
  it('runs and resolves the @/ alias', async () => {
    const mod = await import('@/lib/trip/sse')
    expect(typeof mod.parseSSEChunk).toBe('function')
  })
})
