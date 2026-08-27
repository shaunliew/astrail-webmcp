import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import ExamplePrompts from '../ExamplePrompts'
import { WebMcpRegistryProvider, useWebMcpRegistry } from '../WebMcpRegistry'

const mockPath = vi.hoisted(() => ({ value: '/app' }))
vi.mock('next/navigation', () => ({ usePathname: () => mockPath.value }))

function Supported({ on }: { on: boolean }) {
  const { setSupported } = useWebMcpRegistry()
  useEffect(() => { setSupported(on) }, [on, setSupported])
  return null
}

const show = (supported = true) =>
  render(
    <WebMcpRegistryProvider>
      <Supported on={supported} />
      <ExamplePrompts />
    </WebMcpRegistryProvider>,
  )

beforeEach(() => {
  mockPath.value = '/app'
  window.localStorage.clear()
})

describe('ExamplePrompts', () => {
  it('shows the sentence that answers the reported complaint', async () => {
    // Users said they could not tell where to click or how to start. This is the fix.
    show()
    expect(await screen.findByText(/What can I do here\?/)).toBeInTheDocument()
  })

  it('offers trip-editing prompts on a trip page, not library prompts', async () => {
    mockPath.value = '/app/trip/abc'
    show()
    expect(await screen.findByText(/move stop 7 to day 3/)).toBeInTheDocument()
    expect(screen.queryByText(/What reels do I have saved/)).not.toBeInTheDocument()
  })

  it('stays hidden where there is no agent to talk to', () => {
    // Telling someone to "ask the agent" in plain Safari is worse than saying nothing.
    const { container } = show(false)
    expect(container).toBeEmptyDOMElement()
  })

  it('stays dismissed across mounts', async () => {
    show()
    await userEvent.click(await screen.findByRole('button', { name: /dismiss/i }))
    await waitFor(() => expect(screen.queryByText(/What can I do here\?/)).not.toBeInTheDocument())

    show()
    await waitFor(() => expect(screen.queryByText(/What can I do here\?/)).not.toBeInTheDocument())
  })

  it('still renders when localStorage throws', async () => {
    // Private modes throw on access. A remembered dismissal is not worth a blank panel.
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    try {
      show()
      expect(await screen.findByText(/What can I do here\?/)).toBeInTheDocument()
    } finally {
      spy.mockRestore()
    }
  })
})
