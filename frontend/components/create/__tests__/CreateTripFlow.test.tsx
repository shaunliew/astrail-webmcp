import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const { push, getAccessToken, generateTrip, streamGeneration, useEntitlement, requestSeat } = vi.hoisted(() => ({
  push: vi.fn(),
  getAccessToken: vi.fn(async () => 'token'),
  generateTrip: vi.fn(async () => ({ trip_id: 'trip_tokyo_demo' })),
  streamGeneration: vi.fn(),
  useEntitlement: vi.fn(),
  requestSeat: vi.fn(async () => {}),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/lib/supabase/session', () => ({ getAccessToken }))
// Keep the real ApiError — classifyGenerateError does `err instanceof ApiError` — and only
// override the two network calls the flow makes.
vi.mock('@/lib/trip/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/trip/api')>()),
  generateTrip,
  streamGeneration,
}))
// Drive the entitlement gate through controlled hook states; the real classifyGenerateError
// (and everything else in the module) is preserved.
vi.mock('@/lib/entitlement', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlement')>()),
  useEntitlement,
}))

import CreateTripFlow from '@/components/create/CreateTripFlow'
import MapProvider from '@/components/map/MapProvider'
import { ApiError } from '@/lib/trip/api'

const NOT_EXHAUSTED = {
  loading: false, isTrialExhausted: false, seatRequested: false,
  requestSeat, requesting: false, canonicalTripId: null, canonicalTripLoading: false,
  refetch: vi.fn(),
}

// Drives the compose → brief affordance up to (and including) the "Generate my trip" click.
function submitBrief() {
  fireEvent.change(screen.getByLabelText(/paste.*reel/i), {
    target: { value: 'https://www.instagram.com/reel/AAA/' },
  })
  fireEvent.click(screen.getByRole('button', { name: /add links/i }))
  fireEvent.change(screen.getByLabelText(/start date/i), { target: { value: '2026-08-01' } })
  fireEvent.change(screen.getByLabelText(/end date/i), { target: { value: '2026-08-04' } })
  fireEvent.click(screen.getByRole('button', { name: /review trip brief/i }))
}

describe('CreateTripFlow', () => {
  beforeEach(() => {
    push.mockClear()
    getAccessToken.mockReset()
    generateTrip.mockReset()
    streamGeneration.mockReset()
    useEntitlement.mockReset()
    requestSeat.mockReset()
    NOT_EXHAUSTED.refetch.mockClear() // shared module-scope mock — clear call history between tests
    getAccessToken.mockResolvedValue('token')
    generateTrip.mockResolvedValue({ trip_id: 'trip_tokyo_demo' })
    useEntitlement.mockReturnValue(NOT_EXHAUSTED)
    requestSeat.mockResolvedValue(undefined)
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
    // The terminal 'result' handler must refetch the entitlement (keeps the gate in sync with a
    // failure refund). Guards against silently dropping the call site.
    expect(NOT_EXHAUSTED.refetch).toHaveBeenCalled()
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

  // --- Entitlement gate (Task 9) ---

  it('renders the trial-exhausted card instead of the generate affordance when exhausted', () => {
    useEntitlement.mockReturnValue({ ...NOT_EXHAUSTED, isTrialExhausted: true })
    render(<MapProvider><CreateTripFlow /></MapProvider>)

    expect(screen.getByRole('button', { name: 'Request a seat' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /review trip brief/i })).not.toBeInTheDocument()
  })

  it('shows the generate affordance and no card when not exhausted', () => {
    render(<MapProvider><CreateTripFlow /></MapProvider>)

    expect(screen.getByRole('button', { name: /review trip brief/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /request a seat/i })).not.toBeInTheDocument()
  })

  it('shows the card after generateTrip rejects with a 403 trial_exhausted (post-hoc catch)', async () => {
    generateTrip.mockRejectedValueOnce(new ApiError(403, 'trial_exhausted', 'Your free trip is already planned.'))
    render(<MapProvider><CreateTripFlow /></MapProvider>)
    submitBrief()
    fireEvent.click(await screen.findByRole('button', { name: /generate my trip/i }))

    expect(await screen.findByRole('button', { name: 'Request a seat' })).toBeInTheDocument()
    expect(streamGeneration).not.toHaveBeenCalled()
  })

  it('surfaces a non-trial 409 message verbatim via ApiError and does NOT render the card', async () => {
    const message = 'That request is already being processed — please retry.'
    generateTrip.mockRejectedValueOnce(new ApiError(409, 'conflict_retry', message))
    render(<MapProvider><CreateTripFlow /></MapProvider>)
    submitBrief()
    fireEvent.click(await screen.findByRole('button', { name: /generate my trip/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(screen.queryByRole('button', { name: /request a seat/i })).not.toBeInTheDocument()
  })

  it('catches a rejected requestSeat and surfaces it (no unhandled rejection)', async () => {
    requestSeat.mockRejectedValueOnce(new Error('Seat service is down.'))
    useEntitlement.mockReturnValue({ ...NOT_EXHAUSTED, isTrialExhausted: true })
    render(<MapProvider><CreateTripFlow /></MapProvider>)

    fireEvent.click(screen.getByRole('button', { name: 'Request a seat' }))

    expect(await screen.findByText('Seat service is down.')).toBeInTheDocument()
    expect(requestSeat).toHaveBeenCalledTimes(1)
  })
})
