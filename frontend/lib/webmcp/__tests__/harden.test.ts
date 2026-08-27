import { describe, it, expect, afterEach } from 'vitest'
import { suppressUnregisterAborts } from '../harden'

type Doc = { modelContext?: unknown }
const doc = () => document as unknown as Doc
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((c) => c())
  delete doc().modelContext
})

function start() {
  const stop = suppressUnregisterAborts()
  cleanups.push(stop)
  return stop
}

/** Fire a synthetic unhandledrejection and report whether anything called preventDefault. */
function fireRejection(reason: unknown): boolean {
  const event = new Event('unhandledrejection', { cancelable: true }) as PromiseRejectionEvent & {
    reason?: unknown
  }
  Object.defineProperty(event, 'reason', { value: reason })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

const abortNoReason = () =>
  Object.assign(new Error('signal is aborted without reason'), { name: 'AbortError' })

describe('suppressUnregisterAborts', () => {
  it('suppresses the abort that WebMCP unregistration produces', () => {
    doc().modelContext = { registerTool: () => Promise.resolve() }
    start()
    expect(fireRejection(abortNoReason())).toBe(true)
  })

  it('leaves every other rejection alone', () => {
    doc().modelContext = { registerTool: () => Promise.resolve() }
    start()
    expect(fireRejection(new TypeError('something genuinely broke'))).toBe(false)
  })

  it('leaves an abort that carries a real reason alone', () => {
    // A deliberate abort in our own code passes a reason, so it must still surface.
    doc().modelContext = { registerTool: () => Promise.resolve() }
    start()
    const withReason = Object.assign(new Error('user cancelled the upload'), { name: 'AbortError' })
    expect(fireRejection(withReason)).toBe(false)
  })

  it('does nothing at all when WebMCP is not present', () => {
    // Without a model context this rejection came from somewhere else entirely.
    start()
    expect(fireRejection(abortNoReason())).toBe(false)
  })

  it('stops suppressing after cleanup', () => {
    doc().modelContext = { registerTool: () => Promise.resolve() }
    const stop = suppressUnregisterAborts()
    stop()
    expect(fireRejection(abortNoReason())).toBe(false)
  })

  it('NEVER touches document.modelContext', () => {
    // The regression this file exists for: the first attempt reassigned
    // document.modelContext.registerTool, which is a non-writable property of a native
    // interface. That threw TypeError and took the whole /app shell down with it.
    const frozen = Object.freeze({ registerTool: Object.freeze(() => Promise.resolve()) })
    doc().modelContext = frozen
    expect(() => start()).not.toThrow()
    fireRejection(abortNoReason())
    expect(doc().modelContext).toBe(frozen)
  })

  it('survives a model context that throws on property access', () => {
    // Anything cosmetic must degrade to "the overlay is back", never "the app will not load".
    doc().modelContext = new Proxy({}, { get() { throw new Error('hostile') } })
    expect(() => start()).not.toThrow()
    expect(() => fireRejection(abortNoReason())).not.toThrow()
  })
})
