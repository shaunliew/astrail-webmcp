import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import GenerationProgress from '@/components/create/GenerationProgress'
import type { StreamEvent } from '@/lib/trip/backend-types'

describe('GenerationProgress', () => {
  it('renders each stage event with its human label and message', () => {
    const events: StreamEvent[] = [
      { type: 'stage', stage: 'scrape', msg: 'Scraping 3 Reels…' },
      { type: 'stage', stage: 'dedup', msg: 'Mapped 4 verified places.' },
    ]
    render(<GenerationProgress events={events} />)
    expect(screen.getByText(/scraping reels/i)).toBeInTheDocument()
    expect(screen.getByText('Scraping 3 Reels…')).toBeInTheDocument()
    expect(screen.getByText('Mapped 4 verified places.')).toBeInTheDocument()
  })

  it('shows the completion line on the terminal result event', () => {
    const events: StreamEvent[] = [
      { type: 'stage', stage: 'summarize', msg: 'Summarizing…' },
      { type: 'result', content: JSON.stringify({ trip_id: 'trip_tokyo_demo' }) },
    ]
    render(<GenerationProgress events={events} />)
    expect(screen.getByText(/opening your trip/i)).toBeInTheDocument()
  })

  it('renders a waiting state before any event arrives', () => {
    render(<GenerationProgress events={[]} />)
    expect(screen.getByTestId('generation-progress')).toBeInTheDocument()
    expect(screen.getByText(/starting/i)).toBeInTheDocument()
  })

  it('the astronaut waits while generating and holds still once the result lands', () => {
    const { container, rerender } = render(
      <GenerationProgress events={[{ type: 'stage', stage: 'scrape', msg: 'Scraping…' }]} />,
    )
    expect(container.querySelector('[data-mascot="astronaut"]')).not.toBeNull()
    expect(container.querySelector('.astronaut-trail--waiting')).not.toBeNull()
    rerender(
      <GenerationProgress
        events={[{ type: 'result', content: JSON.stringify({ trip_id: 't' }) }]}
      />,
    )
    expect(container.querySelector('.astronaut-trail--waiting')).toBeNull()
  })
})

describe('the always-visible working state', () => {
  /* Four minutes of real waiting produced one report: "I'm not sure how the progress is, the
     UI should be more obvious that it is still loading or doing something." The trail alone
     could not answer it — it grows past the height of the sheet, so during the long concurrent
     tail the newest line is scrolled out of view and the visible part of the screen is frozen.

     So the rail carries one line that is always on screen: what the run is doing right now, a
     dot that only animates while it is alive, and a clock. The clock is the honest liveness
     signal — it is a measured wait, not a fabricated percentage, and it keeps moving for a
     reader who has asked for no animation at all. */
  const SCRAPE: StreamEvent = { type: 'stage', stage: 'scrape', msg: 'Reading 3 Reels' }
  const RESULT: StreamEvent = { type: 'result', content: JSON.stringify({ trip_id: 't' }) }

  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  function advance(ms: number) {
    act(() => { vi.advanceTimersByTime(ms) })
  }

  it('names the current stage even when the trail has scrolled it out of view', () => {
    render(<GenerationProgress events={[SCRAPE, { type: 'stage', stage: 'hotels', msg: 'Looking' }]} />)
    expect(screen.getByTestId('generation-now')).toHaveTextContent('Searching hotels')
  })

  it('keeps the working state pinned when the trail grows past the sheet', () => {
    // jsdom computes no layout, so the class is the only thing there is to assert — but it is
    // also the entire mechanism: the sheet in GenerationScene is the scroll container, and
    // without `sticky` this block leaves the screen after about a dozen events, which on a real
    // run is the first thirty seconds of a three-minute wait.
    render(<GenerationProgress events={[SCRAPE]} />)
    expect(screen.getByTestId('generation-header').className).toContain('sticky')
    expect(screen.getByTestId('generation-header')).toContainElement(screen.getByTestId('generation-now'))
  })

  it('runs a clock while the generation is alive', () => {
    render(<GenerationProgress events={[SCRAPE]} />)
    expect(screen.getByTestId('generation-elapsed')).toHaveTextContent('0:00')
    advance(65_000)
    expect(screen.getByTestId('generation-elapsed')).toHaveTextContent('1:05')
  })

  it('stops the clock once the run is terminal', () => {
    const { rerender } = render(<GenerationProgress events={[SCRAPE]} />)
    advance(12_000)
    expect(screen.getByTestId('generation-elapsed')).toHaveTextContent('0:12')

    rerender(<GenerationProgress events={[SCRAPE, RESULT]} />)
    advance(30_000)
    expect(screen.getByTestId('generation-elapsed')).toHaveTextContent('0:12')
  })

  it('animates the live dot while running and holds it still on the result', () => {
    const { rerender } = render(<GenerationProgress events={[SCRAPE]} />)
    expect(screen.getByTestId('generation-live-dot').className).toContain('pulse-dot--live')

    rerender(<GenerationProgress events={[SCRAPE, RESULT]} />)
    expect(screen.getByTestId('generation-live-dot').className).not.toContain('pulse-dot--live')
  })

  it('reads as an arrival on the result rather than one more line in the trail', () => {
    render(<GenerationProgress events={[SCRAPE, RESULT]} />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/ready/i)
    expect(screen.getByTestId('generation-now')).toHaveTextContent(/opening your trip/i)
  })
})

/**
 * A failed run must never flash "Your trip is ready".
 *
 * A leased failure terminates the stream with a `result` frame like any other run — the payload
 * carries `{error: …}` where a success carries `{itinerary: …}`. This screen asked only whether a
 * `result` had arrived, so it drew the success headline on a dead run. The page does recover, but
 * only after paint: the user sees the arrival first and the failure second.
 *
 * Keyed on `readResultVerdict`, which is deliberately the app's ONE rule for this — it tests for
 * the PRESENCE of an `error` key, so a failure that lost its message is still a failure.
 */
describe('the ending it announces is the ending that happened', () => {
  const withResult = (payload: unknown): StreamEvent[] => [
    { type: 'stage', stage: 'narrate', msg: 'Writing your days…' },
    { type: 'result', content: JSON.stringify(payload) },
  ]

  it('does not call a failed run ready', () => {
    render(<GenerationProgress events={withResult({ error: 'lease lost' })} />)
    expect(screen.queryByText(/your trip is ready/i)).toBeNull()
    expect(screen.queryByText(/opening your trip/i)).toBeNull()
    expect(screen.getByText(/didn.t finish/i)).toBeInTheDocument()
  })

  it('does not call a failure ready just because it lost its message', () => {
    // `{"error": null}` is the frame a truthiness test read as a finished trip.
    render(<GenerationProgress events={withResult({ error: null })} />)
    expect(screen.queryByText(/your trip is ready/i)).toBeNull()
    expect(screen.getByText(/didn.t finish/i)).toBeInTheDocument()
  })

  it('does not assert either outcome for a payload it could not read', () => {
    // Telling someone their trip failed when it may not have is how they pay to generate a trip
    // they already have. It says the run stopped, and points at the page.
    render(<GenerationProgress events={[{ type: 'result', content: 'not json at all' }]} />)
    expect(screen.queryByText(/your trip is ready/i)).toBeNull()
    expect(screen.queryByText(/didn.t finish/i)).toBeNull()
    expect(screen.getByText(/check your trips/i)).toBeInTheDocument()
  })

  it('still calls a real success ready', () => {
    render(<GenerationProgress events={withResult({ itinerary: { days: [] } })} />)
    expect(screen.getByText(/your trip is ready/i)).toBeInTheDocument()
  })

  it('stops the clock on a failure, not only on a success', () => {
    // A run that is over is over whichever way it went. A clock still counting on a dead run is
    // the same lie as a pulse on a finished one.
    vi.useFakeTimers()
    try {
      render(<GenerationProgress events={withResult({ error: 'lease lost' })} />)
      const before = screen.getByTestId('generation-elapsed').textContent
      act(() => { vi.advanceTimersByTime(5_000) })
      expect(screen.getByTestId('generation-elapsed').textContent).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not paint the finished dot on a failed run', () => {
    render(<GenerationProgress events={withResult({ error: 'lease lost' })} />)
    const dot = screen.getByTestId('generation-live-dot')
    expect(dot.className).not.toContain('pulse-dot--ok')
    expect(dot.className).not.toContain('pulse-dot--live')
  })
})
