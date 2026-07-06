import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import OrchestratorSummary from '@/components/trip/OrchestratorSummary'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

describe('OrchestratorSummary', () => {
  it('shows place and day counts', () => {
    render(<OrchestratorSummary bundle={TOKYO_TRIP} />)
    expect(
      within(screen.getByTestId('stat-places')).getByText(String(TOKYO_TRIP.places.length)),
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId('stat-days')).getByText(String(TOKYO_TRIP.days.length)),
    ).toBeInTheDocument()
  })

  it('flags saved_with_gaps status', () => {
    render(<OrchestratorSummary bundle={TOKYO_TRIP} />)
    expect(screen.getByText(/gaps/i)).toBeInTheDocument()
  })
})
