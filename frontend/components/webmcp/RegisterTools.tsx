'use client'

import { useEffect } from 'react'
import { useRegisterTool } from '@/lib/webmcp/use-register-tool'
import type { ToolSpec } from '@/lib/webmcp/types'
import { useOptionalWebMcpRegistry } from './WebMcpRegistry'

/**
 * One component per tool, deliberately.
 *
 * `useRegisterTool` is a hook, so it cannot be called in a loop whose length varies. Giving each tool
 * its own component means React handles the lifecycle: mount registers, unmount unregisters, and
 * a trip page navigating away takes its tools with it without any manual AbortController.
 *
 * The hook solves the trap this would otherwise hit — a changing `execute` does NOT
 * trigger re-registration, so the callback always sees current state without the tool churning.
 * That is why our specs take reader FUNCTIONS rather than values.
 */
function ToolRegistration({ spec, enabled = true }: { spec: ToolSpec; enabled?: boolean }) {
  // OPTIONAL on purpose. Tool registration goes to `document.modelContext`; the registry only
  // feeds the in-page status chip. Hard-requiring it would mean TripWorkspace — a core product
  // component — crashes anywhere the agent layer is not mounted, which is a bad trade for a
  // cosmetic feature. Without a provider the tool still registers; it just is not listed.
  const registry = useOptionalWebMcpRegistry()
  // Depend on the individual callbacks, NEVER on the registry object itself.
  // The context value is memoized on `tools`, so `registry` changes every time a tool reports —
  // and an effect that both depends on `registry` and calls `report()` re-triggers itself
  // forever ("Maximum update depth exceeded"). These three are stable: report/withdraw are
  // useCallback([]) and setSupported is a state setter.
  const report = registry?.report
  const withdraw = registry?.withdraw
  const setSupported = registry?.setSupported
  const beginActivity = registry?.beginActivity
  const endActivity = registry?.endActivity

  const { supported, registered, error } = useRegisterTool(
    {
      ...spec,
      // Wrapping here rather than in each tool means EVERY call is announced, including reads.
      // A read the user never sees is a read they could not consent to.
      execute: async (args: Record<string, unknown>) => {
        const id = beginActivity?.(spec.name)
        try {
          const result = await spec.execute(args)
          if (id !== undefined) endActivity?.(id, 'done', typeof result === 'string' ? result.split('\n')[0] : undefined)
          return result
        } catch (e) {
          if (id !== undefined) endActivity?.(id, 'failed', e instanceof Error ? e.message : undefined)
          throw e
        }
      },
    },
    enabled,
  )

  useEffect(() => {
    setSupported?.(supported)
  }, [supported, setSupported])

  useEffect(() => {
    if (error) console.error(`[webmcp] "${spec.name}" registration error:`, error)
    if (!report || !withdraw) return
    if (!enabled) {
      withdraw(spec.name)
      return
    }
    report({
      name: spec.name,
      description: spec.description,
      readOnly: spec.annotations?.readOnlyHint === true,
      registered,
    })
    return () => withdraw(spec.name)
  }, [spec.name, spec.description, spec.annotations?.readOnlyHint, registered, enabled, error, report, withdraw])

  return null
}

/**
 * `enabled` gates PRESENCE, never content — descriptions and schemas are captured at
 * registration and must stay static. A tool that should not be offered yet (editing a trip that
 * is still generating) is withheld entirely rather than described differently.
 */
export function RegisterTools({ specs, enabled = true }: { specs: ToolSpec[]; enabled?: boolean }) {
  return (
    <>
      {specs.map((spec) => (
        <ToolRegistration key={spec.name} spec={spec} enabled={enabled} />
      ))}
    </>
  )
}
