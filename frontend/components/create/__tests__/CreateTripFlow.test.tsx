import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { push, createTrip, streamGeneration } = vi.hoisted(() => ({
  push: vi.fn(),
  createTrip: vi.fn(async () => ({ trip_id: 'trip_tokyo_demo' })),
  streamGeneration: vi.fn((_id: string, onEvent: (e: unknown) => void) => {
    onEvent({ type: 'stage', stage: 'scrape', msg: 'Scraping 3 Reels…' })
    onEvent({ type: 'stage', stage: 'dedup', msg: 'Mapped 4 verified places.' })
    onEvent({ type: 'result', content: JSON.stringify({ trip_id: 'trip_tokyo_demo' }) })
    return { cancel: () => {} }
  }),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/lib/trip/mock-api', () => ({ createTrip, streamGeneration }))

import CreateTripFlow from '@/components/create/CreateTripFlow'

describe('CreateTripFlow', () => {
  beforeEach(() => {
    push.mockClear(); createTrip.mockClear(); streamGeneration.mockClear()
  })

  it('disables Generate until there is at least one item', () => {
    render(<CreateTripFlow />)
    expect(screen.getByRole('button', { name: /generate/i })).toBeDisabled()
  })

  it('creates the trip, streams progress, and routes to the trip view', async () => {
    render(<CreateTripFlow />)
    fireEvent.change(screen.getByLabelText(/paste.*reel/i), {
      target: { value: 'https://www.instagram.com/reel/AAA/' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add links/i }))
    fireEvent.change(screen.getByLabelText(/start date/i), { target: { value: '2026-08-01' } })
    fireEvent.change(screen.getByLabelText(/end date/i), { target: { value: '2026-08-04' } })

    fireEvent.click(screen.getByRole('button', { name: /generate/i }))

    await waitFor(() => expect(createTrip).toHaveBeenCalledTimes(1))
    expect(streamGeneration).toHaveBeenCalledWith('trip_tokyo_demo', expect.any(Function))
    expect(await screen.findByText('Mapped 4 verified places.')).toBeInTheDocument()
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/trip/trip_tokyo_demo'))
  })

  it('does not start the stream or navigate if unmounted while createTrip is pending', async () => {
    let resolveCreate!: (v: { trip_id: string }) => void
    createTrip.mockImplementationOnce(() => new Promise((res) => { resolveCreate = res }))

    const { unmount } = render(<CreateTripFlow />)
    fireEvent.change(screen.getByLabelText(/paste.*reel/i), {
      target: { value: 'https://www.instagram.com/reel/AAA/' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add links/i }))
    fireEvent.change(screen.getByLabelText(/start date/i), { target: { value: '2026-08-01' } })
    fireEvent.change(screen.getByLabelText(/end date/i), { target: { value: '2026-08-04' } })
    fireEvent.click(screen.getByRole('button', { name: /generate/i }))

    await waitFor(() => expect(createTrip).toHaveBeenCalledTimes(1))
    unmount() // unmount BEFORE createTrip resolves
    resolveCreate({ trip_id: 'trip_tokyo_demo' })
    await Promise.resolve(); await Promise.resolve() // flush the awaited continuation

    expect(streamGeneration).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })
})
