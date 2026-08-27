import { describe, it, expect } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RegisterTools } from '../RegisterTools'
import { WebMcpRegistryProvider } from '../WebMcpRegistry'
import WebMcpStatus from '../WebMcpStatus'
import type { ToolSpec } from '@/lib/webmcp/types'

const spec = (name: string): ToolSpec => ({
  name,
  description: `A tool called ${name} that does something for the agent.`,
  execute: () => 'ok',
  annotations: { readOnlyHint: true },
})

describe('RegisterTools inside the real provider', () => {
  it('settles instead of re-rendering forever', async () => {
    // Regression, found only in a real browser: the effect depended on the whole context value,
    // which is memoized on `tools` — so report() -> new tools -> new context -> effect -> report()
    // looped until React threw "Maximum update depth exceeded". Every earlier unit test seeded
    // the registry directly and never rendered RegisterTools inside the provider, so all of them
    // passed while the trip page was unusable.
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => { errors.push(args[0]) }
    try {
      render(
        <WebMcpRegistryProvider>
          <RegisterTools specs={[spec('tool_one'), spec('tool_two')]} />
          <WebMcpStatus open={false} onOpenChange={() => {}} />
        </WebMcpRegistryProvider>,
      )
      await waitFor(() => expect(screen.getByRole('button')).toBeInTheDocument())
      const depthErrors = errors.filter((e) => String(e).includes('Maximum update depth'))
      expect(depthErrors).toHaveLength(0)
    } finally {
      console.error = original
    }
  })

  it('lists each registered tool exactly once', async () => {
    render(
      <WebMcpRegistryProvider>
        <RegisterTools specs={[spec('tool_one'), spec('tool_two')]} />
        <WebMcpStatus open={false} onOpenChange={() => {}} />
      </WebMcpRegistryProvider>,
    )
    // No WebMCP in jsdom, so the chip reports unavailable — but the registration path still ran
    // without looping, which is what this file exists to prove.
    await userEvent.click(await screen.findByRole('button'))
    expect(screen.getByText(/WebMCP unavailable/)).toBeInTheDocument()
  })

  it('handles a spec list that changes identity every render', async () => {
    // GlobalTools rebuilds its specs array on each render; that must not cause churn either.
    function Churny() {
      return <RegisterTools specs={[spec('tool_one')]} />
    }
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => { errors.push(args[0]) }
    try {
      const { rerender } = render(
        <WebMcpRegistryProvider><Churny /></WebMcpRegistryProvider>,
      )
      for (let i = 0; i < 5; i++) {
        rerender(<WebMcpRegistryProvider><Churny /></WebMcpRegistryProvider>)
      }
      await waitFor(() => {
        expect(errors.filter((e) => String(e).includes('Maximum update depth'))).toHaveLength(0)
      })
    } finally {
      console.error = original
    }
  })
})
