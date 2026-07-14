import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import EvidenceChip from '@/components/trip/EvidenceChip'
import type { TripPlaceEvidence } from '@/lib/trip/backend-types'

const reel: TripPlaceEvidence = {
  confidence: 0.82, source_url: 'https://instagram.com/reel/abc',
  quote: 'the temple at dawn is unreal', quotes: ['the temple at dawn is unreal'],
  rationale: null, evidence_kind: 'reel_quote',
}

describe('EvidenceChip', () => {
  it('shows confidence as a percentage and the kind label', () => {
    render(<EvidenceChip evidence={reel} />)
    expect(screen.getByText('82%')).toBeInTheDocument()
    expect(screen.getByText(/reel/i)).toBeInTheDocument()
  })

  it('links to the source when a url is present', () => {
    render(<EvidenceChip evidence={reel} />)
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', reel.source_url)
  })

  it('renders without a link when source_url is null', () => {
    render(<EvidenceChip evidence={{ ...reel, source_url: null }} />)
    expect(screen.queryByRole('link')).toBeNull()
  })
})
