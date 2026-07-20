import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import DayOverview from '@/components/trip/DayOverview'
import { TOKYO_TRIP } from '@/lib/trip/fixtures'

describe('DayOverview', () => {
  it('renders the narrated day title, summary, and weather with its source tag', () => {
    const day = TOKYO_TRIP.days[0]
    render(<DayOverview day={day} />)
    expect(screen.getByText(day.title as string)).toBeInTheDocument()
    expect(screen.getByText(day.summary as string)).toBeInTheDocument()
    expect(screen.getByText(day.weather_summary as string)).toBeInTheDocument()
    expect(screen.getByText('Weather')).toBeInTheDocument()
  })

  it('omits the weather line entirely for days beyond the forecast window', () => {
    const day = TOKYO_TRIP.days[2] // fixture's intentional weather gap
    render(<DayOverview day={day} />)
    expect(screen.getByText(day.title as string)).toBeInTheDocument()
    expect(screen.queryByText('Weather')).not.toBeInTheDocument()
  })

  it('renders nothing when the narrator produced no content', () => {
    const empty = { ...TOKYO_TRIP.days[0], title: null, summary: null, weather_summary: null }
    const { container } = render(<DayOverview day={empty} />)
    expect(container).toBeEmptyDOMElement()
  })
})
