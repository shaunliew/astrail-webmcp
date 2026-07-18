import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import TradeoffPanel from '@/components/trip/TradeoffPanel'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

describe('TradeoffPanel', () => {
  it('renders nothing when both tradeoff axes are empty', () => {
    const { container } = render(<TradeoffPanel tradeoffs={{ notes: [], comparisons: [] }} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders deterministic notes', () => {
    const note = TOKYO_TRIP.trip.tradeoffs.notes[0]
    render(<TradeoffPanel tradeoffs={{ notes: [note], comparisons: [] }} />)
    expect(screen.getByText(note.detail)).toBeInTheDocument()
  })

  it('renders hotel comparisons with Astrail attribution', () => {
    const comparison = TOKYO_TRIP.trip.tradeoffs.comparisons[0]
    render(<TradeoffPanel tradeoffs={{ notes: [], comparisons: [comparison] }} />)
    expect(screen.getByRole('heading', { name: 'Price vs rating' })).toBeInTheDocument()
    expect(screen.getByText(comparison.option_a.label)).toBeInTheDocument()
    expect(screen.getByText(comparison.option_b.label)).toBeInTheDocument()
    expect(screen.getByText('Astrail')).toBeInTheDocument()
  })
})
