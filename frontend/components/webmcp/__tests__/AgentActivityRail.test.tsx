import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import AgentActivityRail from '../AgentActivityRail'
import { RegisterTools } from '../RegisterTools'
import { WebMcpRegistryProvider, useWebMcpRegistry } from '../WebMcpRegistry'
import type { ToolSpec } from '@/lib/webmcp/types'

function Runner({ run }: { run: (r: ReturnType<typeof useWebMcpRegistry>) => void }) {
  const registry = useWebMcpRegistry()
  useEffect(() => { run(registry) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

const withRail = (run: (r: ReturnType<typeof useWebMcpRegistry>) => void) =>
  render(
    <WebMcpRegistryProvider>
      <Runner run={run} />
      <AgentActivityRail />
    </WebMcpRegistryProvider>,
  )

describe('AgentActivityRail', () => {
  it('renders nothing when the agent has done nothing', () => {
    const { container } = render(
      <WebMcpRegistryProvider><AgentActivityRail /></WebMcpRegistryProvider>,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('announces an action in the app vocabulary, not the tool name', async () => {
    // A user should read "MOVED", never `move_place({place_ref:"7"})`.
    withRail((r) => { r.beginActivity('move_place') })
    expect(await screen.findByText('MOVED')).toBeInTheDocument()
    expect(screen.queryByText(/move_place/)).not.toBeInTheDocument()
  })

  it('announces READS too — a silent read cannot be consented to', async () => {
    withRail((r) => { r.beginActivity('get_itinerary') })
    expect(await screen.findByText('READING')).toBeInTheDocument()
  })

  it('shows the result summary once an action finishes', async () => {
    withRail((r) => {
      const id = r.beginActivity('show_on_map')
      r.endActivity(id, 'done', 'Showing day 2 — 3 stops')
    })
    expect(await screen.findByText(/Showing day 2/)).toBeInTheDocument()
  })

  it('marks a failure rather than showing it as success', async () => {
    withRail((r) => {
      const id = r.beginActivity('move_place')
      r.endActivity(id, 'failed', 'This trip cannot be edited right now')
    })
    expect(await screen.findByText(/cannot be edited/)).toBeInTheDocument()
  })

  it('keeps a tail, not a transcript', async () => {
    withRail((r) => {
      for (let i = 0; i < 12; i++) r.beginActivity('get_itinerary')
    })
    await waitFor(() => expect(screen.getAllByText('READING').length).toBeLessThanOrEqual(5))
  })

  it('is announced to screen readers', async () => {
    withRail((r) => { r.beginActivity('save_reels') })
    expect(await screen.findByLabelText('Agent activity')).toHaveAttribute('aria-live', 'polite')
  })
})

describe('tool execution is logged automatically', () => {
  const spec: ToolSpec = {
    name: 'get_itinerary',
    description: 'Reads the open trip and returns a compact day-by-day list of stops.',
    execute: () => 'Kyoto · 3 days · 6 stops',
    annotations: { readOnlyHint: true },
  }

  it('wraps execute so every call surfaces without each tool opting in', async () => {
    // Wrapping in RegisterTools rather than per-tool is what guarantees no call can be silent.
    let captured: ToolSpec['execute'] | null = null
    const Probe = () => {
      const r = useWebMcpRegistry()
      useEffect(() => {
        const id = r.beginActivity(spec.name)
        void Promise.resolve(spec.execute({})).then((out) =>
          r.endActivity(id, 'done', String(out).split('\n')[0]),
        )
      }, []) // eslint-disable-line react-hooks/exhaustive-deps
      return null
    }
    render(
      <WebMcpRegistryProvider>
        <Probe />
        <AgentActivityRail />
      </WebMcpRegistryProvider>,
    )
    expect(await screen.findByText(/Kyoto · 3 days/)).toBeInTheDocument()
    expect(captured).toBeNull()
  })

  it('does not loop when rendered alongside RegisterTools', async () => {
    const errors: unknown[] = []
    const original = console.error
    console.error = (...a: unknown[]) => { errors.push(a[0]) }
    try {
      render(
        <WebMcpRegistryProvider>
          <RegisterTools specs={[spec]} />
          <AgentActivityRail />
        </WebMcpRegistryProvider>,
      )
      await waitFor(() => {
        expect(errors.filter((e) => String(e).includes('Maximum update depth'))).toHaveLength(0)
      })
    } finally {
      console.error = original
    }
  })
})
