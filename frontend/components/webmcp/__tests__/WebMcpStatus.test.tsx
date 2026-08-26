import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import WebMcpStatus from '../WebMcpStatus'
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
