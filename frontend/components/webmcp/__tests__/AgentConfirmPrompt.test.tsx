import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useRef } from 'react'
import AgentConfirm from '../AgentConfirm'
import { WebMcpRegistryProvider, useWebMcpRegistry, type PromptAnswer } from '../WebMcpRegistry'

/* The SECOND card: an approval that also lets the user say "actually, this trip is different".
   Its own file, so the nine tests pinning the plain confirm card are provably untouched — the
   whole design rests on that branch not having moved. */

const FIELD = { label: 'Different this trip?', placeholder: 'e.g. slower days, more temples' }

function Asker({ summary, onAnswer }: { summary: string; onAnswer: (v: PromptAnswer | 'unavailable') => void }) {
  const { requestPrompt } = useWebMcpRegistry()
  const fired = useRef(false)
  useEffect(() => {
    if (fired.current) return
    fired.current = true
    void requestPrompt(summary, FIELD).then(onAnswer)
  }, [requestPrompt, summary, onAnswer])
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

const field = () => screen.getByLabelText(/different this trip/i)
const approve = () => screen.getByRole('button', { name: /use/i })

describe('AgentConfirm — the preference card', () => {
  it('shows the request verbatim, with an optional field beside it', async () => {
    ask('Plan a trip from 4 reels\nAstrail will try to recall: walkable days\nThis uses your trip allowance.')
    expect(await screen.findByText(/This uses your trip allowance/)).toBeInTheDocument()
    expect(screen.getByText(/walkable days/)).toBeInTheDocument()
    expect(field()).toBeInTheDocument()
  })

  it('starts EMPTY, however much the summary names', async () => {
    /* The remembered text is mem0 prose that reaches the store through the agent's own
       `preferences` argument. Seeding it into the input would let it be submitted back as the
       user's own words without anyone typing them. Blank means "use what you remember". */
    ask('Astrail will try to recall: walkable days · good ramen')
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(field()).toHaveValue('')
  })

  it('answers with no override when approved blank', async () => {
    const onAnswer = ask('Spend the allowance')
    await userEvent.click(await approve())
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith({ approved: true, text: null }))
  })

  it('answers null, never an empty string, for a field holding only spaces', async () => {
    /* `''` is falsy and the backend's blank check is `(explicit_text or "").strip()`. A `'  '`
       forwarded as a preference is a run that states nothing while claiming it stated something:
       recall is skipped and the blank is remembered. */
    const onAnswer = ask('Spend the allowance')
    await userEvent.type(await field(), '   ')
    await userEvent.click(approve())
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith({ approved: true, text: null }))
  })

  it('answers with the typed override, trimmed', async () => {
    const onAnswer = ask('Spend the allowance')
    await userEvent.type(await field(), '  beach days, no temples  ')
    await userEvent.click(approve())
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith({ approved: true, text: 'beach days, no temples' }))
  })

  it('carries nothing forward when the user declines, whatever they typed', async () => {
    // Declining is a refusal to start, not a preference. Text on a declined card is not consent.
    const onAnswer = ask('Spend the allowance')
    await userEvent.type(await field(), 'beach days')
    await userEvent.click(screen.getByRole('button', { name: /not now/i }))
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith({ approved: false, text: null }))
  })

  it('names what the approve button will actually do', async () => {
    /* One button doing two things must not describe only one of them. "Use what it remembers"
       while a typed override is on screen is the card telling the user the opposite of what
       clicking it does. */
    ask('Spend the allowance')
    expect(await approve()).toHaveAccessibleName(/use what it remembers/i)
    await userEvent.type(field(), 'beach days')
    expect(approve()).toHaveAccessibleName(/use this instead/i)
  })

  it('dismisses itself once answered', async () => {
    ask('Spend the allowance')
    await userEvent.click(await approve())
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('does NOT render caption-derived text as markup', async () => {
    // Same summary, same untrusted origin as the plain card — so the same rule.
    ask('<img src=x onerror="alert(1)"> sneaky')
    const dialog = await screen.findByRole('dialog')
    expect(dialog.querySelector('img')).toBeNull()
    expect(dialog.textContent).toContain('<img src=x')
  })

  it('shares ONE card slot with the plain confirm, in both directions', async () => {
    /* The gate is the reason a second irreversible action cannot stack behind a dialog nobody
       has read. A second door into the same state that did not go through it would reopen
       exactly that hole. */
    const second = vi.fn()
    const third = vi.fn()
    function Two() {
      const { requestConfirm, requestPrompt } = useWebMcpRegistry()
      const fired = useRef(false)
      useEffect(() => {
        if (fired.current) return
        fired.current = true
        void requestPrompt('first', FIELD)
        void requestConfirm('second').then(second)
        void requestPrompt('third', FIELD).then(third)
      }, [requestConfirm, requestPrompt])
      return null
    }
    render(
      <WebMcpRegistryProvider>
        <Two />
        <AgentConfirm />
      </WebMcpRegistryProvider>,
    )
    await screen.findByRole('dialog')
    // `'unavailable'`, never a `false`/`{approved:false}` — nobody was asked, so nobody declined.
    await waitFor(() => expect(second).toHaveBeenCalledWith('unavailable'))
    await waitFor(() => expect(third).toHaveBeenCalledWith('unavailable'))
    expect(screen.getByText('first')).toBeInTheDocument()
    expect(field()).toBeInTheDocument()
  })

  it('lets a plain confirm through once the preference card has been answered', async () => {
    // The slot is released by answering, not held for the session.
    const after = vi.fn()
    function Sequence() {
      const { requestConfirm, requestPrompt } = useWebMcpRegistry()
      const fired = useRef(false)
      useEffect(() => {
        if (fired.current) return
        fired.current = true
        void requestPrompt('first', FIELD).then(() => { void requestConfirm('after').then(after) })
      }, [requestConfirm, requestPrompt])
      return null
    }
    render(
      <WebMcpRegistryProvider>
        <Sequence />
        <AgentConfirm />
      </WebMcpRegistryProvider>,
    )
    await userEvent.click(await approve())
    expect(await screen.findByText('after')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /approve/i }))
    await waitFor(() => expect(after).toHaveBeenCalledWith(true))
  })
})
