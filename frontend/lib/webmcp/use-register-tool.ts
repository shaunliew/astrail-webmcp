'use client'

import { useEffect, useRef, useState } from 'react'
import type { ToolSpec } from './types'

/**
 * Register one WebMCP tool.
 *
 * This replaces `use-webmcp-tool@0.2.0`, which is otherwise a good hook, for one reason: it calls
 *
 *   try { document.modelContext.registerTool(tool, { signal }) } catch { ... }
 *   return () => controller.abort()
 *
 * without awaiting or catching the returned Promise. Aborting the signal is HOW WebMCP
 * unregisters a tool, so every unmount rejects a promise nobody holds and the browser reports
 * `AbortError: signal is aborted without reason` — which Next.js renders as a full-screen overlay
 * on every trip-page visit.
 *
 * That cannot be fixed from outside the library:
 *   - `document.modelContext.registerTool` is a NON-WRITABLE property of a native interface, so
 *     wrapping it throws `TypeError: Cannot assign to read only property` (and took /app down).
 *   - An `unhandledrejection` listener cannot win either: `preventDefault()` does not stop other
 *     listeners, and Next's overlay handler is registered at bootstrap, long before any effect.
 *
 * So we own the registration and simply catch our own promise. Everything the hook did well is
 * kept, deliberately:
 */
export type RegisterState = {
  /** Whether `document.modelContext` exists at all. */
  supported: boolean
  registered: boolean
  error: Error | null
}

type ModelContext = {
  registerTool: (tool: unknown, options?: { signal?: AbortSignal }) => unknown
}

function modelContext(): ModelContext | null {
  if (typeof document === 'undefined') return null
  const mc = (document as unknown as { modelContext?: ModelContext }).modelContext
  return mc && typeof mc.registerTool === 'function' ? mc : null
}

/** The MCP result envelope. A tool returning a bare string is the common case. */
function toToolResponse(value: unknown): unknown {
  if (value && typeof value === 'object' && 'content' in (value as object)) return value
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }
}

function toErrorResponse(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error)
  return { content: [{ type: 'text', text: message }], isError: true }
}

export function useRegisterTool(spec: ToolSpec | null, enabled = true): RegisterState {
  const [state, setState] = useState<RegisterState>({ supported: false, registered: false, error: null })

  // Assigned during render so `execute` always sees current state. Registration must NOT depend
  // on it: re-registering whenever a closure changes would churn the agent's tool list on every
  // keystroke, and previously drove an infinite render loop.
  const specRef = useRef(spec)
  specRef.current = spec

  // Bumped when a late-injected model context is detected, to re-run registration.
  const [detectTick, setDetectTick] = useState(0)

  const name = spec?.name ?? null
  const enabledNow = enabled && spec !== null

  useEffect(() => {
    const mc = modelContext()

    if (!mc) {
      setState({ supported: false, registered: false, error: null })
      // The API can be injected after mount (an extension, or the browser wiring up late), so
      // look for a while before concluding it is absent.
      let attempts = 0
      const timer = setInterval(() => {
        if (modelContext()) {
          clearInterval(timer)
          setDetectTick((n) => n + 1)
        } else if (++attempts >= 20) {
          clearInterval(timer)
        }
      }, 500)
      return () => clearInterval(timer)
    }

    if (!enabledNow || !name) {
      setState({ supported: true, registered: false, error: null })
      return
    }

    const controller = new AbortController()
    let live = true

    try {
      const result = mc.registerTool(
        {
          name,
          description: specRef.current!.description,
          inputSchema: specRef.current!.inputSchema,
          annotations: specRef.current!.annotations,
          async execute(args: Record<string, unknown>) {
            try {
              return toToolResponse(await specRef.current!.execute(args))
            } catch (error) {
              return toErrorResponse(error)
            }
          },
        },
        { signal: controller.signal },
      )

      // THE FIX. registerTool returns a Promise and aborting the signal rejects it — that is
      // simply what unregistration looks like, not a failure worth reporting.
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void (result as Promise<unknown>).catch((error: unknown) => {
          if ((error as { name?: string } | null)?.name === 'AbortError') return
          if (!live) return
          setState({ supported: true, registered: false, error: error instanceof Error ? error : new Error(String(error)) })
        })
      }

      setState({ supported: true, registered: true, error: null })
    } catch (error) {
      // e.g. NotAllowedError when the `tools` permissions policy is disabled.
      setState({
        supported: true,
        registered: false,
        error: error instanceof Error ? error : new Error(String(error)),
      })
    }

    return () => {
      live = false
      controller.abort()
    }
    // Registration is keyed on identity + presence only, never on the closure.
  }, [name, enabledNow, detectTick])

  return state
}
