'use client'

import { useEffect } from 'react'
import { useRegisterTool } from '@/lib/webmcp/use-register-tool'
import { readToolOutcome } from '@/lib/webmcp/tools/edit'
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
          // NOT "it returned, therefore it worked". A declined approval card and a backend
          // refusal both come back as an ordinary value, and reading those as success is what
          // put `REMOVED · You · done — Astrail can't undo this` in a permanent record for a
          // removal the user had refused, with the stop still on the map beside it. The reply
          // says which of the three it was; `readToolOutcome` believes it only when it is one
          // of the three words, so a tool that says nothing is still recorded as it was before.
          if (id !== undefined) {
            // `decidedBy` travels with the outcome and by the same rule: a value the tool's own
            // code wrote, believed only when it is one of the three words. Undefined leaves the
            // rail on the tool's static answer, which is right for every tool without a card.
            const { outcome, detail, decidedBy } = readToolOutcome(result)
            endActivity?.(id, outcome, detail, decidedBy)
          }
          return result
        } catch (e) {
          /* A THROW, not a returned refusal: the tool blew up rather than answering, so nothing
             said who decided it and the static default is the only honest answer available. */
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
