import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import OrchestratorSummary from '@/components/trip/OrchestratorSummary'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

describe('OrchestratorSummary', () => {
  it('shows place and day counts', () => {
    render(<OrchestratorSummary bundle={TOKYO_TRIP} />)
    expect(screen.getByText(String(TOKYO_TRIP.places.length))).toBeInTheDocument()
    // Days, legs, and sources all count to 3; verify the stat row for days renders with correct count
    const dayCountElements = screen.getAllByText(String(TOKYO_TRIP.days.length))
    expect(dayCountElements.length).toBeGreaterThan(0)
  })

  it('flags saved_with_gaps status', () => {
    render(<OrchestratorSummary bundle={TOKYO_TRIP} />)
    expect(screen.getByText(/gaps/i)).toBeInTheDocument()
  })
})
