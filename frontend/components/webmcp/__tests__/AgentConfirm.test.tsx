import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useRef } from 'react'
import AgentConfirm from '../AgentConfirm'
import { WebMcpRegistryProvider, useWebMcpRegistry } from '../WebMcpRegistry'

function Asker({ summary, onAnswer }: { summary: string; onAnswer: (v: boolean | 'unavailable') => void }) {
  const { requestConfirm } = useWebMcpRegistry()
  const fired = useRef(false)
  useEffect(() => {
    if (fired.current) return
    fired.current = true
    void requestConfirm(summary).then(onAnswer)
  }, [requestConfirm, summary, onAnswer])
  return null
}

const ask = (summary: string, onAnswer = vi.fn()) => {
  render(
    <WebMcpRegistryProvider>
      <Asker summary={summary} onAnswer={onAnswer} />
      <AgentConfirm />
    </WebMcpRegistryProvider>,
  )
  return onAnswer
}

describe('AgentConfirm', () => {
  it('renders nothing when no approval is pending', () => {
    const { container } = render(
      <WebMcpRegistryProvider>
        <AgentConfirm />
      </WebMcpRegistryProvider>,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the agent request verbatim', async () => {
    ask('Plan a trip from 3 reels\nDates: 2026-03-03 to 2026-03-07\nThis uses your trip allowance.')
    expect(await screen.findByText(/This uses your trip allowance/)).toBeInTheDocument()
    expect(screen.getByText(/Dates: 2026-03-03/)).toBeInTheDocument()
  })

  it('resolves true on approve', async () => {
    const onAnswer = ask('Spend the allowance')
    await userEvent.click(await screen.findByRole('button', { name: /approve/i }))
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(true))
  })

  it('resolves false on decline — the tool must be able to say nothing was spent', async () => {
    const onAnswer = ask('Spend the allowance')
    await userEvent.click(await screen.findByRole('button', { name: /not now/i }))
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(false))
  })

  it('dismisses itself once answered', async () => {
    ask('Spend the allowance')
    await userEvent.click(await screen.findByRole('button', { name: /approve/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('does NOT render caption-derived text as markup', async () => {
    // The summary can carry Reel-caption content, which is attacker-writable. Rendering it as
    // HTML would let a caption forge interface chrome or hide what is about to be spent.
    ask('<img src=x onerror="alert(1)"> sneaky')
    const dialog = await screen.findByRole('dialog')
    expect(dialog.querySelector('img')).toBeNull()
    expect(dialog.textContent).toContain('<img src=x')
  })

  it('refuses a second request rather than queueing it behind an unread dialog', async () => {
    const second = vi.fn()
    function Two() {
      const { requestConfirm } = useWebMcpRegistry()
      const fired = useRef(false)
      useEffect(() => {
        if (fired.current) return
        fired.current = true
        void requestConfirm('first')
        void requestConfirm('second').then(second)
      }, [requestConfirm])
      return null
    }
    render(
      <WebMcpRegistryProvider>
        <Two />
        <AgentConfirm />
      </WebMcpRegistryProvider>,
    )
    await screen.findByRole('dialog')
    /* `'unavailable'`, never `false`. A `false` here is the same value a real "Not now" produces,
       so every gated tool answered "The user declined" for a card that was never shown — the
       agent repeated it to the user as fact and the rail wrote it into a permanent record against
       "You". Nobody was asked. The refusal itself is right; answering on the user's behalf is not. */
    await waitFor(() => expect(second).toHaveBeenCalledWith('unavailable'))
    expect(second).not.toHaveBeenCalledWith(false)
    expect(screen.getByText('first')).toBeInTheDocument()
  })

  it('still shows the FIRST card, and still answers it normally', async () => {
    // The gate's actual job. Turning the second request away must not disturb the one on screen.
    const first = vi.fn()
    function One() {
      const { requestConfirm } = useWebMcpRegistry()
      const fired = useRef(false)
      useEffect(() => {
        if (fired.current) return
        fired.current = true
        void requestConfirm('only').then(first)
      }, [requestConfirm])
      return null
    }
    render(
      <WebMcpRegistryProvider>
        <One />
        <AgentConfirm />
      </WebMcpRegistryProvider>,
    )
    await screen.findByRole('dialog')
    await userEvent.click(screen.getByRole('button', { name: /approve/i }))
    await waitFor(() => expect(first).toHaveBeenCalledWith(true))
  })
})
