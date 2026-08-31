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

  it('keeps the prompts bare, with no recovery caveat beside them', async () => {
    /* Two assertions lived here pinning a recovery hint in the footer — "ask it to use Astrail's
       tools" — and the copy they watched was deliberately removed, so they went with it rather
       than being left to pass vacuously against a footer that no longer says anything.

       What replaces them is the rule that made the copy go: a caveat next to the prompts reads,
       to someone who has not hit the problem, as an admission the integration is flaky. Bare
       prompts mostly do reach the tools, and an agent picking the right one from ordinary
       language is the thing being shown off. The hint belongs where someone stuck would look —
       it is a row in SUBMISSION.md's state-of-each-path table — not in front of every reader. */
    show()

    const footer = await screen.findByText(/Type these in ChatGPT/i)
    expect(footer.textContent ?? '').not.toMatch(/site tools|use Astrail|clicking|instead of/i)
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
