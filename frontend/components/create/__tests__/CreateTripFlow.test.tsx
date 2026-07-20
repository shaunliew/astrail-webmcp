import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { push, getAccessToken, generateTrip, streamGeneration } = vi.hoisted(() => ({
  push: vi.fn(),
  getAccessToken: vi.fn(async () => 'token'),
  generateTrip: vi.fn(async () => ({ trip_id: 'trip_tokyo_demo' })),
  streamGeneration: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/lib/supabase/session', () => ({ getAccessToken }))
vi.mock('@/lib/trip/api', () => ({ generateTrip, streamGeneration }))

import CreateTripFlow from '@/components/create/CreateTripFlow'
import MapProvider from '@/components/map/MapProvider'

describe('CreateTripFlow', () => {
  beforeEach(() => {
    push.mockClear()
    getAccessToken.mockReset()
    generateTrip.mockReset()
    streamGeneration.mockReset()
    getAccessToken.mockResolvedValue('token')
    generateTrip.mockResolvedValue({ trip_id: 'trip_tokyo_demo' })
    streamGeneration.mockImplementation(
      (_id: string, _token: string, onEvent: (e: unknown) => void, onReset?: () => void) => {
        onReset?.()
        onEvent({ type: 'stage', stage: 'scrape', msg: 'Scraping 3 Reels...' })
        onEvent({ type: 'stage', stage: 'dedup', msg: 'Mapped 4 verified places.' })
        onEvent({ type: 'result', content: JSON.stringify({ trip_id: 'trip_tokyo_demo' }) })
        return { cancel: () => {} }
      },
    )
  })

  it('disables Generate until there is at least one item', () => {
    render(<MapProvider><CreateTripFlow /></MapProvider>)
    expect(screen.getByRole('button', { name: /review trip brief/i })).toBeDisabled()
  })

  it('creates the trip, streams progress, and routes to the trip view', async () => {
    render(<MapProvider><CreateTripFlow /></MapProvider>)
    fireEvent.change(screen.getByLabelText(/paste.*reel/i), {
      target: { value: 'https://www.instagram.com/reel/AAA/' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add links/i }))
    fireEvent.change(screen.getByLabelText(/start date/i), { target: { value: '2026-08-01' } })
    fireEvent.change(screen.getByLabelText(/end date/i), { target: { value: '2026-08-04' } })

    fireEvent.click(screen.getByRole('button', { name: /review trip brief/i }))
    fireEvent.click(await screen.findByRole('button', { name: /generate my trip/i }))

    await waitFor(() => expect(generateTrip).toHaveBeenCalledTimes(1))
    expect(getAccessToken).toHaveBeenCalledTimes(1)
    expect(streamGeneration).toHaveBeenCalledWith(
      'trip_tokyo_demo',
      'token',
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    )
    expect(await screen.findByText('Mapped 4 verified places.')).toBeInTheDocument()
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/trip/trip_tokyo_demo'))
  })

  it('does not start the stream or navigate if unmounted while generateTrip is pending', async () => {
    let resolveGenerate!: (v: { trip_id: string }) => void
    generateTrip.mockImplementationOnce(() => new Promise((res) => { resolveGenerate = res }))

    const { unmount } = render(<MapProvider><CreateTripFlow /></MapProvider>)
    fireEvent.change(screen.getByLabelText(/paste.*reel/i), {
      target: { value: 'https://www.instagram.com/reel/AAA/' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add links/i }))
    fireEvent.change(screen.getByLabelText(/start date/i), { target: { value: '2026-08-01' } })
    fireEvent.change(screen.getByLabelText(/end date/i), { target: { value: '2026-08-04' } })
    fireEvent.click(screen.getByRole('button', { name: /review trip brief/i }))
    fireEvent.click(await screen.findByRole('button', { name: /generate my trip/i }))

    await waitFor(() => expect(generateTrip).toHaveBeenCalledTimes(1))
    unmount() // unmount BEFORE generateTrip resolves
    resolveGenerate({ trip_id: 'trip_tokyo_demo' })
    await Promise.resolve(); await Promise.resolve() // flush the awaited continuation

    expect(streamGeneration).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })
})
