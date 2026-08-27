/**
 * Work around an unhandled rejection in `use-webmcp-tool@0.2.0`.
 *
 * The hook registers like this:
 *
 *   try { document.modelContext.registerTool(tool, { signal: controller.signal }) }
 *   catch (error) { ... }
 *   return () => controller.abort()
 *
 * `registerTool` returns a Promise (the spec's WebIDL says so), but the call is never awaited and
 * the promise is never `.catch()`ed — and that `try/catch` only ever sees a SYNCHRONOUS throw.
 * Aborting the signal is how WebMCP unregisters a tool, so every unmount and every
 * re-registration rejects a promise nobody is holding. The browser reports it as
 * `AbortError: signal is aborted without reason`, and in dev Next.js throws a full-screen error
 * overlay over a perfectly healthy app.
 *
 * We cannot fix the library from here, but we can make its promise handled: wrap `registerTool`
 * once so an abort-driven rejection is swallowed and anything else is surfaced. The caller still
 * receives the original promise, so behaviour is unchanged.
 */

type Hardenable = {
  registerTool?: (...args: unknown[]) => unknown
  __astrailHardened?: boolean
}

function modelContext(): Hardenable | null {
  if (typeof document === 'undefined') return null
  return (document as unknown as { modelContext?: Hardenable }).modelContext ?? null
}

/** Returns true once the wrap is in place (or was already). */
export function hardenModelContext(): boolean {
  const mc = modelContext()
  if (!mc || typeof mc.registerTool !== 'function') return false
  if (mc.__astrailHardened) return true

  const original = mc.registerTool.bind(mc)
  mc.registerTool = (...args: unknown[]) => {
    const result = original(...args)
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      // Attaching a handler is the whole point — it marks the rejection as handled. Never
      // re-throw here: that would just create a second unhandled rejection.
      void (result as Promise<unknown>).catch((error: unknown) => {
        const name = (error as { name?: string } | null)?.name
        if (name === 'AbortError') return // expected: this is how a tool unregisters
        console.error('[webmcp] registerTool rejected:', error)
      })
    }
    return result
  }
  mc.__astrailHardened = true
  return true
}

/**
 * `document.modelContext` can be injected after mount (an extension's content script, or the
 * browser wiring it up late), so poll briefly rather than checking once. The window matches the
 * hook's own detection window; past that it has given up too.
 */
export function hardenWhenAvailable(windowMs = 10_000, stepMs = 500): () => void {
  if (hardenModelContext()) return () => {}
  let elapsed = 0
  const timer = setInterval(() => {
    elapsed += stepMs
    if (hardenModelContext() || elapsed >= windowMs) clearInterval(timer)
  }, stepMs)
  return () => clearInterval(timer)
}
