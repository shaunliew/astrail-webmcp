import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
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
