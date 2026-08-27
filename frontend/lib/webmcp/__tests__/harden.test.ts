import { describe, it, expect, vi, afterEach } from 'vitest'
import { hardenModelContext, hardenWhenAvailable } from '../harden'

type Doc = { modelContext?: unknown }
const doc = () => document as unknown as Doc
afterEach(() => { delete doc().modelContext; vi.useRealTimers() })

describe('hardenModelContext', () => {
  it('does nothing when there is no WebMCP', () => {
    expect(hardenModelContext()).toBe(false)
  })

  it('marks an abort-driven rejection as handled', async () => {
    // The real failure: use-webmcp-tool never catches registerTool's promise, and aborting the
    // signal is how a tool UNREGISTERS — so every unmount threw an AbortError overlay.
    const rejected = Promise.reject(Object.assign(new Error('signal is aborted without reason'), { name: 'AbortError' }))
    doc().modelContext = { registerTool: () => rejected }

    const unhandled: unknown[] = []
    const onUnhandled = (e: PromiseRejectionEvent) => { unhandled.push(e.reason); e.preventDefault() }
    window.addEventListener('unhandledrejection', onUnhandled)

    expect(hardenModelContext()).toBe(true)
    ;(doc().modelContext as { registerTool: () => unknown }).registerTool()
    await new Promise((r) => setTimeout(r, 0))

    window.removeEventListener('unhandledrejection', onUnhandled)
    expect(unhandled).toHaveLength(0)
  })

  it('still surfaces a rejection that is NOT an abort', async () => {
    // Swallowing everything would hide a genuinely broken tool registration.
    const err = Object.assign(new Error('bad schema'), { name: 'TypeError' })
    doc().modelContext = { registerTool: () => Promise.reject(err) }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    hardenModelContext()
    ;(doc().modelContext as { registerTool: () => unknown }).registerTool()
    await new Promise((r) => setTimeout(r, 0))
    expect(spy).toHaveBeenCalledWith('[webmcp] registerTool rejected:', err)
    spy.mockRestore()
  })

  it('returns the original promise so callers are unaffected', async () => {
    const value = { ok: true }
    doc().modelContext = { registerTool: () => Promise.resolve(value) }
    hardenModelContext()
    await expect((doc().modelContext as { registerTool: () => Promise<unknown> }).registerTool()).resolves.toBe(value)
  })

  it('is idempotent — never double-wraps', () => {
    let calls = 0
    doc().modelContext = { registerTool: () => { calls++; return Promise.resolve() } }
    hardenModelContext()
    hardenModelContext()
    ;(doc().modelContext as { registerTool: () => unknown }).registerTool()
    expect(calls).toBe(1)
  })

  it('tolerates a synchronous registerTool', () => {
    doc().modelContext = { registerTool: () => undefined }
    expect(hardenModelContext()).toBe(true)
    expect(() => (doc().modelContext as { registerTool: () => unknown }).registerTool()).not.toThrow()
  })
})

describe('hardenWhenAvailable', () => {
  it('picks up a late-injected model context', () => {
    vi.useFakeTimers()
    const stop = hardenWhenAvailable(10_000, 500)
    doc().modelContext = { registerTool: () => Promise.resolve() }
    vi.advanceTimersByTime(500)
    expect((doc().modelContext as { __astrailHardened?: boolean }).__astrailHardened).toBe(true)
    stop()
  })

  it('gives up rather than polling forever', () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(global, 'clearInterval')
    hardenWhenAvailable(1_000, 500)
    vi.advanceTimersByTime(1_200)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
