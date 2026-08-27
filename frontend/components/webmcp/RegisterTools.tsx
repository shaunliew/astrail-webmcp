'use client'

import { useEffect } from 'react'
import { useWebMCP } from 'use-webmcp-tool'
import type { ToolSpec } from '@/lib/webmcp/types'
import { useOptionalWebMcpRegistry } from './WebMcpRegistry'

/**
 * One component per tool, deliberately.
 *
 * `useWebMCP` is a hook, so it cannot be called in a loop whose length varies. Giving each tool
 * its own component means React handles the lifecycle: mount registers, unmount unregisters, and
 * a trip page navigating away takes its tools with it without any manual AbortController.
 *
 * The hook already solves the trap this would otherwise hit — a changing `execute` does NOT
 * trigger re-registration, so the callback always sees current state without the tool churning.
 * That is why our specs take reader FUNCTIONS rather than values.
 */
function ToolRegistration({ spec, enabled = true }: { spec: ToolSpec; enabled?: boolean }) {
  // OPTIONAL on purpose. Tool registration goes to `document.modelContext`; the registry only
  // feeds the in-page status chip. Hard-requiring it would mean TripWorkspace — a core product
  // component — crashes anywhere the agent layer is not mounted, which is a bad trade for a
  // cosmetic feature. Without a provider the tool still registers; it just is not listed.
  const registry = useOptionalWebMcpRegistry()

  const { supported, registered, error } = useWebMCP({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    annotations: spec.annotations,
    execute: spec.execute,
    enabled,
    onError: (e) => {
      // A rejected registration is an ABSENT tool: nothing throws, nothing logs, it is simply
      // missing from the agent's list. Surfacing it is the only way to notice before a judge does.
      console.error(`[webmcp] tool "${spec.name}" failed:`, e)
    },
  })

  useEffect(() => {
    registry?.setSupported(supported)
  }, [supported, registry])

  useEffect(() => {
    if (error) console.error(`[webmcp] "${spec.name}" registration error:`, error)
    if (!registry) return
    if (!enabled) {
      registry.withdraw(spec.name)
      return
    }
    registry.report({
      name: spec.name,
      description: spec.description,
      readOnly: spec.annotations?.readOnlyHint === true,
      registered,
    })
    return () => registry.withdraw(spec.name)
  }, [spec.name, spec.description, spec.annotations?.readOnlyHint, registered, enabled, error, registry])

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
