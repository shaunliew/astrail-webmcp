import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import AgentBand from '@/components/reels/AgentBand'

/* The band is the first thing read on a /app home that HAS content, so its two jobs are
   asserted here rather than only through TraysScreen: it must say what the pair can do next
   in terms of the user's real library, and it must hand over a prompt that runs as written.

   Copy is hardcoded here, not imported from the component, so these are a spec and not a
   tautology — the prompt in particular has to keep satisfying `plan_trip_from_reels`, which
   refuses anything without both dates as YYYY-MM-DD.

   The dates in the fixture are arbitrary and this file needs no fake clock: the band is handed
   a FINISHED string and only has to render it verbatim. TraysScreen owns the window and proves
   it comes off the clock ('hands the band the same clock-derived dates…'); the pair below just
   matches what that test pins, so a grep for the demo dates lands on one window, not two. */

const PROMPT =
  'Look at my saved reels in Astrail and plan me a trip from them. ' +
  'Start date 2026-09-08, end date 2026-09-13. Mid-range budget, walkable days.'

function stubClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
}

/** Matched on FULL text — a partial match would not prove the prompt is runnable as written. */
const promptBlock = () =>
  screen.getByText((_content, el) => el?.tagName === 'PRE' && el.textContent === PROMPT)

describe('AgentBand', () => {
  afterEach(() => { cleanup() })

  it('says what the pair can do next, counted against the real library', () => {
    render(<AgentBand savedCount={12} prompt={PROMPT} />)

    expect(
      screen.getByText(
        'With this page open, ChatGPT can read your 12 saved reels, save new links, and plan a trip from them — you approve every step here.',
      ),
    ).toBeInTheDocument()
  })

  it('counts one saved reel in the singular', () => {
    render(<AgentBand savedCount={1} prompt={PROMPT} />)

    expect(
      screen.getByText(
        'With this page open, ChatGPT can read your 1 saved reel, save new links, and plan a trip from them — you approve every step here.',
      ),
    ).toBeInTheDocument()
  })

  it('drops the number rather than guess it when the count is not known', () => {
    // The saved-reel fetch lives in the parent; an in-flight and a failed read both arrive as
    // "no number". Printing "0 saved reels" over a library we have not read is a lie a judge
    // would catch, so the sentence loses the count instead.
    render(<AgentBand savedCount={null} prompt={PROMPT} />)

    expect(
      screen.getByText(
        'With this page open, ChatGPT can read your saved reels, save new links, and plan a trip from them — you approve every step here.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/0 saved/)).toBeNull()
  })

  it('renders the prompt verbatim and copies exactly that text', async () => {
    const writeText = vi.fn(async () => {})
    stubClipboard(writeText)
    render(<AgentBand savedCount={3} prompt={PROMPT} />)

    expect(promptBlock()).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /copy prompt/i }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PROMPT))
    expect(await screen.findByText('Copied. Paste it into ChatGPT with this page open.')).toBeInTheDocument()
  })

  it('falls back to the selectable text when the clipboard refuses', async () => {
    // Clipboard access is permission-gated and absent entirely over plain http. The prompt is
    // rendered as selectable text for exactly that case, so the fallback has to point at it.
    stubClipboard(vi.fn(async () => { throw new Error('denied') }))
    render(<AgentBand savedCount={3} prompt={PROMPT} />)

    fireEvent.click(screen.getByRole('button', { name: /copy prompt/i }))

    expect(
      await screen.findByText('Copy did not work in this browser — select the prompt and copy it yourself.'),
    ).toBeInTheDocument()
    expect(promptBlock()).toBeInTheDocument()
  })

  it('is a labelled region, so it is one thing and not loose copy above the page', () => {
    // It sits above the page heading, which is only tolerable if a screen reader can name it
    // and move past it. It also gives the TraysScreen tests something to scope queries to.
    render(<AgentBand savedCount={3} prompt={PROMPT} />)

    expect(screen.getByRole('region', { name: 'Astrail agent' })).toBeInTheDocument()
  })
})
