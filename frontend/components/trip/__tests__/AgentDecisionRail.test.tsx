import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import AgentDecisionRail from '@/components/trip/AgentDecisionRail'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

describe('AgentDecisionRail', () => {
  it('renders a row per generation event with its message', () => {
    render(<AgentDecisionRail events={TOKYO_TRIP.events} />)
    expect(screen.getByText(TOKYO_TRIP.events[0].message)).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(TOKYO_TRIP.events.length)
  })

  it('translates stage enums to English — raw enum strings never render (§8)', () => {
    render(<AgentDecisionRail events={TOKYO_TRIP.events} />)
    // fixture has a 'scrape' stage event -> the shipped English label
    expect(screen.getAllByText('Scraping Reels').length).toBeGreaterThan(0)
    // and no bare snake_case stage tag anywhere
    expect(screen.queryByText('create_trip')).not.toBeInTheDocument()
  })

  it('visually distinguishes warning events', () => {
    const warning = TOKYO_TRIP.events.find((e) => e.event_type === 'warning')!
    render(<AgentDecisionRail events={[warning]} />)
    expect(screen.getByText(warning.message)).toBeInTheDocument()
    expect(screen.getByText(/warning/i)).toBeInTheDocument()
  })
})
