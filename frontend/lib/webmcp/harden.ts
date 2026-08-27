/**
 * Suppress the unhandled rejection that `use-webmcp-tool@0.2.0` leaves behind.
 *
 * The hook registers like this:
 *
 *   try { document.modelContext.registerTool(tool, { signal: controller.signal }) }
 *   catch (error) { ... }
 *   return () => controller.abort()
 *
 * `registerTool` returns a Promise, but the call is never awaited and never `.catch()`ed — and
 * that `try/catch` only ever sees a SYNCHRONOUS throw. Aborting the signal is how WebMCP
 * unregisters a tool, so every unmount rejects a promise nobody holds. The browser reports
 * `AbortError: signal is aborted without reason`, and Next.js renders a full-screen overlay over
 * a perfectly healthy app.
 *
 * A first attempt wrapped `document.modelContext.registerTool`. That was wrong: on a real
 * implementation the method is a NON-WRITABLE property of a native interface, so assigning to it
 * throws `TypeError: Cannot assign to read only property` — which broke the whole /app shell.
 * The lesson is baked in below: never assume a platform object is patchable, and never let a
 * cosmetic fix run outside a try/catch.
 *
 * So instead of touching the platform object we listen for the rejection and mark it handled.
 * Narrow on purpose — see `isWebMcpUnregisterAbort`.
 */

/** Exactly what an abort with no reason produces. Anything richer is somebody else's error. */
function isWebMcpUnregisterAbort(reason: unknown): boolean {
  if (typeof document === 'undefined') return false
  // Only meaningful when WebMCP is actually in play; otherwise leave every rejection alone.
  if (!(document as unknown as { modelContext?: unknown }).modelContext) return false
  const err = reason as { name?: string; message?: string } | null
  if (!err || err.name !== 'AbortError') return false
  // `AbortController.abort()` with no argument produces this exact message across engines.
  // A deliberate abort in our own code passes a reason, so it will never match here.
  return typeof err.message === 'string' && /aborted without reason/i.test(err.message)
}

/**
 * Start suppressing. Returns a cleanup function.
 *
 * Everything is defensive: this exists only to stop a cosmetic overlay, so any failure inside it
 * must degrade to "the overlay is back", never to "the app will not load".
 */
export function suppressUnregisterAborts(): () => void {
  if (typeof window === 'undefined') return () => {}

  const onRejection = (event: PromiseRejectionEvent) => {
    try {
      if (!isWebMcpUnregisterAbort(event.reason)) return
      // Marking it handled is the whole fix; nothing else about the app changes.
      event.preventDefault()
    } catch {
      // Never let the suppressor itself break the page.
    }
  }

  try {
    window.addEventListener('unhandledrejection', onRejection)
  } catch {
    return () => {}
  }
  return () => {
    try {
      window.removeEventListener('unhandledrejection', onRejection)
    } catch {
      /* nothing useful to do */
    }
  }
}
