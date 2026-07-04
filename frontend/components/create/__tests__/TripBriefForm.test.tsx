import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import TripBriefForm from '@/components/create/TripBriefForm'
import type { BriefInput } from '@/lib/trip/parse-inspiration'

const BRIEF: BriefInput = {
  destination_hint: '', start_date: '', end_date: '',
  origin_city: '', budget_level: '', preferences: '',
}

describe('TripBriefForm', () => {
  it('emits the edited destination hint through onChange', () => {
    const onChange = vi.fn()
    render(<TripBriefForm brief={BRIEF} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/destination/i), { target: { value: 'Tokyo' } })
    expect(onChange).toHaveBeenCalledWith({ ...BRIEF, destination_hint: 'Tokyo' })
  })

  it('emits the selected budget level', () => {
    const onChange = vi.fn()
    render(<TripBriefForm brief={BRIEF} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText(/budget/i), { target: { value: 'mid_range' } })
    expect(onChange).toHaveBeenCalledWith({ ...BRIEF, budget_level: 'mid_range' })
  })

  it('shows the inferred-default helper copy when preferences are empty', () => {
    render(<TripBriefForm brief={BRIEF} onChange={vi.fn()} />)
    expect(screen.getByText(/astrail will infer your trip style/i)).toBeInTheDocument()
  })

  it('hides the inferred-default helper once preferences are provided', () => {
    render(<TripBriefForm brief={{ ...BRIEF, preferences: 'ramen and walkable days' }} onChange={vi.fn()} />)
    expect(screen.queryByText(/astrail will infer your trip style/i)).not.toBeInTheDocument()
  })
})
