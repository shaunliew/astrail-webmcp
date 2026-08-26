'use client'

import { createContext, useCallback, useContext, useMemo, useState } from 'react'

/**
 * A view of what is currently registered, so the UI can SHOW the user what the agent can do.
 *
 * WanderNote surfaces its tool list in-page, and it is worth copying for three separate reasons:
 * a first-time user cannot ask for a capability they cannot see; a judge gets immediate proof
 * the integration is real (and it should agree with ChatGPT's own address-bar list); and it is
 * our dev inspector for free, so there is no separate debug route to build and then hide.
 */

export type RegisteredToolView = {
  name: string
  description: string
  readOnly: boolean
  registered: boolean
}

type RegistryValue = {
  tools: RegisteredToolView[]
  /** Whether `document.modelContext` exists at all — false in an ordinary browser. */
  supported: boolean
  report: (view: RegisteredToolView) => void
  withdraw: (name: string) => void
  setSupported: (v: boolean) => void
}

const Ctx = createContext<RegistryValue | null>(null)

export function useWebMcpRegistry(): RegistryValue {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useWebMcpRegistry must be used inside <WebMcpRegistryProvider>')
  return ctx
}

/** Safe outside the provider — the landing page renders without one. */
export function useOptionalWebMcpRegistry(): RegistryValue | null {
  return useContext(Ctx)
}

export function WebMcpRegistryProvider({ children }: { children: React.ReactNode }) {
  const [tools, setTools] = useState<RegisteredToolView[]>([])
  const [supported, setSupported] = useState(false)

  const report = useCallback((view: RegisteredToolView) => {
    setTools((prev) => {
      const rest = prev.filter((t) => t.name !== view.name)
      // Sorted by name so the list does not reshuffle as tools register in effect order.
      return [...rest, view].sort((a, b) => a.name.localeCompare(b.name))
    })
  }, [])

  const withdraw = useCallback((name: string) => {
    setTools((prev) => prev.filter((t) => t.name !== name))
  }, [])

  const value = useMemo<RegistryValue>(
    () => ({ tools, supported, report, withdraw, setSupported }),
    [tools, supported, report, withdraw],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
