import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { useState } from 'react'
import WebMcpStatusBase from '../WebMcpStatus'

/** The dock owns the open state in the app; this mirrors that for the component under test. */
function WebMcpStatus() {
  const [open, setOpen] = useState(false)
  return <WebMcpStatusBase open={open} onOpenChange={setOpen} />
}
import { WebMcpRegistryProvider, useWebMcpRegistry } from '../WebMcpRegistry'

function Seed({ tools }: { tools: { name: string; description: string; readOnly: boolean }[] }) {
  const { report, setSupported } = useWebMcpRegistry()
  useEffect(() => {
    setSupported(tools.length > 0)
    tools.forEach((t) => report({ ...t, registered: true }))
  }, [tools, report, setSupported])
  return null
}

const withRegistry = (tools: { name: string; description: string; readOnly: boolean }[]) =>
  render(
    <WebMcpRegistryProvider>
      <Seed tools={tools} />
      <WebMcpStatus />
    </WebMcpRegistryProvider>,
  )

describe('RegisterTools without a provider', () => {
  it('renders tools outside a WebMcpRegistryProvider without throwing', async () => {
    // Regression: TripWorkspace mounts tool registration, and hard-requiring the registry made
    // that core product component crash in every context where the agent layer is not mounted.
    // Registration targets document.modelContext; the registry only feeds the status chip.
    const { RegisterTools } = await import('../RegisterTools')
    const spec = {
      name: 'demo_tool',
      description: 'x'.repeat(30),
      execute: () => 'ok',
      annotations: { readOnlyHint: true },
    }
    expect(() => render(<RegisterTools specs={[spec]} />)).not.toThrow()
  })
})

describe('WebMcpStatus', () => {
  it('renders nothing outside a provider rather than throwing', () => {
    // The landing page has no provider; a crash there would take the marketing page down.
    const { container } = render(<WebMcpStatus />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the live tool count', async () => {
    withRegistry([
      { name: 'get_app_state', description: 'Where you are', readOnly: true },
      { name: 'move_place', description: 'Move a stop', readOnly: false },
    ])
    expect(await screen.findByText(/WebMCP active · 2 tools/)).toBeInTheDocument()
  })

  it('explains how to enable it when the browser has no WebMCP', async () => {
    // A judge on the wrong browser must never meet a dead UI with no explanation.
    withRegistry([])
    expect(await screen.findByText(/WebMCP unavailable/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button'))
    expect(screen.getByText(/ChatGPT desktop app/)).toBeInTheDocument()
    expect(screen.getByText(/enable-webmcp-testing/)).toBeInTheDocument()
    expect(screen.getByText(/still works normally/)).toBeInTheDocument()
  })

  it('closes again — both from the chip and from an explicit close button', async () => {
    // The reported bug: the panel rendered BELOW the chip inside a bottom-anchored box, so
    // opening it pushed the chip upward and the click target moved out from under the cursor.
    withRegistry([{ name: 'get_app_state', description: 'Where you are', readOnly: true }])
    const chip = await screen.findByRole('button', { name: /WebMCP active/ })

    await userEvent.click(chip)
    expect(screen.getByRole('button', { name: /close tool list/i })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /close tool list/i }))
    expect(screen.queryByRole('button', { name: /close tool list/i })).not.toBeInTheDocument()

    // And the chip itself still toggles, from a position that never moved.
    await userEvent.click(chip)
    expect(screen.getByRole('button', { name: /close tool list/i })).toBeInTheDocument()
    await userEvent.click(chip)
    expect(screen.queryByRole('button', { name: /close tool list/i })).not.toBeInTheDocument()
  })

  it('renders the panel BEFORE the chip in the DOM so the chip stays anchored', async () => {
    // Structural guard for the same bug: in a bottom-anchored column the last child sits at the
    // bottom edge. If the panel ever moves after the chip again, the chip starts jumping.
    withRegistry([{ name: 'get_app_state', description: 'Where you are', readOnly: true }])
    await userEvent.click(await screen.findByRole('button', { name: /WebMCP active/ }))
    const panel = screen.getByRole('button', { name: /close tool list/i }).closest('div.w-full')
    const chip = screen.getByRole('button', { name: /WebMCP active/ })
    expect(panel!.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('caps the tool list height so a long catalogue never runs off a phone screen', async () => {
    withRegistry(
      Array.from({ length: 13 }, (_, i) => ({
        name: `tool_${i}`, description: 'x'.repeat(120), readOnly: i % 2 === 0,
      })),
    )
    await userEvent.click(await screen.findByRole('button', { name: /WebMCP active/ }))
    const scroller = document.querySelector('.overflow-y-auto')
    expect(scroller).toBeTruthy()
    expect(scroller!.className).toContain('max-h-[60dvh]')
  })

  it('distinguishes tools that read from tools that change things', async () => {
    withRegistry([
      { name: 'get_itinerary', description: 'Read the trip', readOnly: true },
      { name: 'remove_place', description: 'Delete a stop', readOnly: false },
    ])
    await userEvent.click(await screen.findByRole('button'))
    expect(screen.getByText('reads')).toBeInTheDocument()
    expect(screen.getByText('changes')).toBeInTheDocument()
  })
})
