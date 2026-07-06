import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import PlaceIntelPanel from '@/components/trip/PlaceIntelPanel'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

describe('PlaceIntelPanel', () => {
  it('prompts to select a place when none is selected', () => {
    render(<PlaceIntelPanel tripPlace={null} />)
    expect(screen.getByText(/select a place/i)).toBeInTheDocument()
  })

  it('shows the selected place name, location, and evidence', () => {
    const tp = TOKYO_TRIP.places[0]
    render(<PlaceIntelPanel tripPlace={tp} />)
    expect(screen.getByRole('heading', { name: new RegExp(tp.place.name, 'i') })).toBeInTheDocument()
    const pct = `${Math.round(tp.evidence_json.confidence * 100)}%`
    expect(screen.getByText(pct)).toBeInTheDocument()
  })
})
