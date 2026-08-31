import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import DaySelector from '@/components/trip/DaySelector'
import { orderedDays } from '@/lib/trip/selectors'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

const days = orderedDays(TOKYO_TRIP)

describe('DaySelector', () => {
  it('renders a button per day and marks the active one', () => {
    render(<DaySelector days={days} activeDayNumber={2} onSelect={() => {}} />)
    expect(screen.getAllByRole('tab')).toHaveLength(days.length)
    expect(screen.getByRole('tab', { name: /day 2/i })).toHaveAttribute('aria-pressed', 'true')
  })

  it('calls onSelect with the day number when a tab is clicked', () => {
    // The LAST day, whichever that is — clicking a literal 'day 3' found no tab once the trip
    // was consolidated to two days, and a missing tab fails as a lookup error rather than as
    // this test's actual claim.
    const last = days[days.length - 1].day_number!
    const onSelect = vi.fn()
    render(<DaySelector days={days} activeDayNumber={1} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(`day ${last}`, 'i') }))
    expect(onSelect).toHaveBeenCalledWith(last)
  })
})
