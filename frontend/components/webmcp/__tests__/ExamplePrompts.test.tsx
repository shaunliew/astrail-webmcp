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

  it('says what to do when ChatGPT drives the page instead of calling a tool', async () => {
    /* Every prompt this panel offers is bare, on purpose — the entry's claim is that you talk to
       the app normally, and prompts prefixed "use the site tools" would undermine the thing they
       advertise. But a bare prompt has been observed getting browser control instead: the page
       moves, no tool fires, no approval card appears, and a judge reasonably concludes the
       integration does not work. The recovery has to be offered somewhere, and this panel is
       where the prompts are.

       Asserted as substance, not wording: that the reader is told to ask for the tools, and that
       the limitation is attributed honestly to the agent's choice rather than implied to be
       something Astrail controls. */
    show()

    const footer = await screen.findByText(/Type these in ChatGPT/i)
    expect(footer).toHaveTextContent(/ask it to use them|use Astrail’s own tools/i)
    expect(footer).toHaveTextContent(/ChatGPT’s call|not something a site decides/i)
  })

  it('never claims that saying it once keeps working', async () => {
    // Nobody has tested persistence. Promising it would be a claim about someone else's product
    // that we cannot support, on the surface whose whole subject is not overstating things.
    show()

    const footer = await screen.findByText(/Type these in ChatGPT/i)
    expect(footer.textContent ?? '').not.toMatch(/\b(once|thereafter|from then on|for the rest of)\b/i)
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
