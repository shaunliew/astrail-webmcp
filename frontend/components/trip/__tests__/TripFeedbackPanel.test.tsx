import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TripFeedback, TripFeedbackResponse } from '@/lib/trip/backend-types'

// Partial-mock the API seam: spy submitTripFeedback but KEEP the real ApiError export so the
// component's `instanceof ApiError` branches match the errors these tests construct from the same
// module (the SettingsView.test.tsx:17 / DeleteAccountCard.test.tsx house pattern).
const { submitTripFeedback } = vi.hoisted(() => ({ submitTripFeedback: vi.fn() }))
vi.mock('@/lib/trip/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/trip/api')>()
  return { ...actual, submitTripFeedback }
})

const { getAccessToken } = vi.hoisted(() => ({ getAccessToken: vi.fn() }))
vi.mock('@/lib/supabase/session', () => ({ getAccessToken }))

import TripFeedbackPanel, { buildDraft } from '@/components/trip/TripFeedbackPanel'
import { ApiError } from '@/lib/trip/api'

// A persisted 201 row — the confirmed line is built from THIS, never from the request.
function row(over: Partial<TripFeedback> = {}): TripFeedbackResponse {
  return {
    feedback: {
      id: 'fb-1',
      trip_id: 'trip-1',
      artifact_type: 'trip',
      feedback_type: 'thumbs_up',
      rating: null,
      comment: null,
      ...over,
    },
  }
}

const draftOf = (call: number) => submitTripFeedback.mock.calls[call][1] as Record<string, unknown>

beforeEach(() => {
  submitTripFeedback.mockReset()
  submitTripFeedback.mockResolvedValue(row())
  getAccessToken.mockReset()
  getAccessToken.mockResolvedValue('jwt-token')
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('TripFeedbackPanel — composer', () => {
  // 1
  it('does not POST when a thumb is only selected — submit is a separate action', () => {
    render(<TripFeedbackPanel tripId="trip-1" />)
    fireEvent.click(screen.getByRole('button', { name: /thumbs up/i }))
    expect(submitTripFeedback).not.toHaveBeenCalled()
  })

  // 2
  it('sends exactly { feedback_type: thumbs_up } on thumb + Send', async () => {
    render(<TripFeedbackPanel tripId="trip-1" />)
    fireEvent.click(screen.getByRole('button', { name: /thumbs up/i }))
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }))
    await waitFor(() => expect(submitTripFeedback).toHaveBeenCalledTimes(1))
    expect(draftOf(0)).toEqual({ feedback_type: 'thumbs_up' })
  })

  it('attaches the trimmed note to the thumb row when a note is typed', async () => {
    render(<TripFeedbackPanel tripId="trip-1" />)
    fireEvent.click(screen.getByRole('button', { name: /thumbs up/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  loved it  ' } })
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }))
    await waitFor(() => expect(submitTripFeedback).toHaveBeenCalledTimes(1))
    expect(draftOf(0)).toEqual({ feedback_type: 'thumbs_up', comment: 'loved it' })
  })

  it('sends exactly { feedback_type: thumbs_down } (symmetric)', async () => {
    render(<TripFeedbackPanel tripId="trip-1" />)
    fireEvent.click(screen.getByRole('button', { name: /thumbs down/i }))
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }))
    await waitFor(() => expect(submitTripFeedback).toHaveBeenCalledTimes(1))
    expect(draftOf(0)).toEqual({ feedback_type: 'thumbs_down' })
  })

  // 3
  it('sends a numeric rating and enforces mutual exclusion in both directions', async () => {
    render(<TripFeedbackPanel tripId="trip-1" />)
    // thumbs-up, then star 4 clears the thumb
    fireEvent.click(screen.getByRole('button', { name: /thumbs up/i }))
    fireEvent.click(screen.getByRole('radio', { name: '4 stars' }))
    expect(screen.getByRole('button', { name: /thumbs up/i })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('radio', { name: '4 stars' })).toHaveAttribute('aria-checked', 'true')
    // star 2 moves the checked radio off 4
    fireEvent.click(screen.getByRole('radio', { name: '2 stars' }))
    expect(screen.getByRole('radio', { name: '4 stars' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('radio', { name: '2 stars' })).toHaveAttribute('aria-checked', 'true')
    // thumbs-up after a star clears the star
    fireEvent.click(screen.getByRole('button', { name: /thumbs up/i }))
    expect(screen.getByRole('radio', { name: '2 stars' })).toHaveAttribute('aria-checked', 'false')
    // settle on star 4 and send → the posted draft carries only the final signal, numeric rating
    fireEvent.click(screen.getByRole('radio', { name: '4 stars' }))
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }))
    await waitFor(() => expect(submitTripFeedback).toHaveBeenCalledTimes(1))
    expect(draftOf(0)).toEqual({ feedback_type: 'rating', rating: 4 })
    expect(typeof draftOf(0).rating).toBe('number')
  })

  // 4 (component-level)
  it('sends free_text from a note alone, and disables Send for a whitespace-only note', async () => {
    render(<TripFeedbackPanel tripId="trip-1" />)
    const send = screen.getByRole('button', { name: /send feedback/i })
    const note = screen.getByRole('textbox')
    // whitespace-only note, no signal → the button predicate keeps Send off
    fireEvent.change(note, { target: { value: '   ' } })
    expect(send).toBeDisabled()
    expect(submitTripFeedback).not.toHaveBeenCalled()
    // a real note → free_text with the trimmed comment
    fireEvent.change(note, { target: { value: '  the route was wrong  ' } })
    expect(send).toBeEnabled()
    fireEvent.click(send)
    await waitFor(() => expect(submitTripFeedback).toHaveBeenCalledTimes(1))
    expect(draftOf(0)).toEqual({ feedback_type: 'free_text', comment: 'the route was wrong' })
  })

  // 4 (pure buildDraft — one assertion per guard, so removing the builder's trim/null guard
  // fails HERE even if the component predicate stays green: BUILD-LOOP §7)
  it('buildDraft trims/nulls independently of the button predicate', () => {
    expect(buildDraft(null, '   ')).toBeNull()
    expect(buildDraft(null, '')).toBeNull()
    expect(buildDraft('thumbs_up', '  x  ')).toEqual({ feedback_type: 'thumbs_up', comment: 'x' })
  })

  // 5
  it('clears the note after a successful send', async () => {
    render(<TripFeedbackPanel tripId="trip-1" />)
    fireEvent.click(screen.getByRole('button', { name: /thumbs up/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'loved it' } })
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }))
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''))
    expect(screen.getByText(/noted — thanks\./i)).toBeInTheDocument()
  })

  it('keeps the note AND the thumb selection after a 429, showing the rate-limit copy', async () => {
    submitTripFeedback.mockRejectedValue(new ApiError(429, 'rate_limited', 'slow down'))
    render(<TripFeedbackPanel tripId="trip-1" />)
    fireEvent.click(screen.getByRole('button', { name: /thumbs up/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'the route was wrong' } })
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }))
    await waitFor(() =>
      expect(screen.getByText(/limited to a few sends a minute/i)).toBeInTheDocument(),
    )
    expect(screen.getByRole('textbox')).toHaveValue('the route was wrong')
    expect(screen.getByRole('button', { name: /thumbs up/i })).toHaveAttribute('aria-pressed', 'true')
  })

  // 6 — confirmed from the persisted row, not the request (the ONLY assertion an
  // update-from-request implementation cannot pass)
  it('builds the "Saved:" line from the persisted row, even when it contradicts the request', async () => {
    submitTripFeedback.mockResolvedValue(row({ feedback_type: 'thumbs_down' }))
    render(<TripFeedbackPanel tripId="trip-1" />)
    fireEvent.click(screen.getByRole('button', { name: /thumbs up/i }))
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }))
    expect(await screen.findByText(/saved: thumbs down/i)).toBeInTheDocument()
    expect(screen.queryByText(/saved: thumbs up/i)).not.toBeInTheDocument()
  })

  it('appends " with note" to the "Saved:" line only when the row carries a comment', async () => {
    submitTripFeedback.mockResolvedValue(row({ feedback_type: 'rating', rating: 4, comment: 'nice' }))
    render(<TripFeedbackPanel tripId="trip-1" />)
    fireEvent.click(screen.getByRole('radio', { name: '4 stars' }))
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }))
    expect(await screen.findByText(/saved: 4 of 5 with note/i)).toBeInTheDocument()
  })

  // A persisted free_text row confirms as exactly "Saved: note" — the note IS the feedback, so
  // there is no " with note" suffix by design (documents the intentional no-suffix wording).
  it('confirms a persisted free_text row as exactly "Saved: note" (no suffix by design)', async () => {
    submitTripFeedback.mockResolvedValue(row({ feedback_type: 'free_text', comment: 'the route was wrong' }))
    render(<TripFeedbackPanel tripId="trip-1" />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'the route was wrong' } })
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }))
    expect(await screen.findByText('Saved: note')).toBeInTheDocument()
  })

  // 6b — no-op resubmission guard (the lastSent fingerprint)
  it('disables Send after a successful send until the draft changes, then posts the NEW draft', async () => {
    render(<TripFeedbackPanel tripId="trip-1" />)
    fireEvent.click(screen.getByRole('button', { name: /thumbs up/i }))
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }))
    await waitFor(() => expect(submitTripFeedback).toHaveBeenCalledTimes(1))
    // identical draft still selected → Send disabled (would otherwise insert a duplicate permanent row)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /send feedback/i })).toBeDisabled(),
    )
    // typing a note changes the fingerprint → re-enabled
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'and one more thing' } })
    expect(screen.getByRole('button', { name: /send feedback/i })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }))
    await waitFor(() => expect(submitTripFeedback).toHaveBeenCalledTimes(2))
    expect(draftOf(1)).toEqual({ feedback_type: 'thumbs_up', comment: 'and one more thing' })
  })

  // 6c — a NOTED send fingerprints the POST-CLEAR bare draft, so clearing the note can't re-arm
  // Send for a permanent bare duplicate (append-only, no delete endpoint). Regression for the
  // fix: the post-clear bare draft is fingerprinted.
  it('keeps Send disabled after a noted thumb send (post-clear bare draft is fingerprinted), re-arming only on a real change', async () => {
    render(<TripFeedbackPanel tripId="trip-1" />)
    fireEvent.click(screen.getByRole('button', { name: /thumbs up/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'loved it' } })
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }))
    await waitFor(() => expect(submitTripFeedback).toHaveBeenCalledTimes(1))
    // note is cleared, but the bare {thumbs_up} it drops to is already the fingerprint → Send OFF
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''))
    const send = screen.getByRole('button', { name: /send feedback/i })
    expect(send).toBeDisabled()
    // the selection itself survives the success (explicit — both final reviewers asked)
    expect(screen.getByRole('button', { name: /thumbs up/i })).toHaveAttribute('aria-pressed', 'true')
    // typing a new note is a real change → re-armed
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'one more thing' } })
    expect(send).toBeEnabled()
    // clearing it back returns to the fingerprinted bare draft → disabled again (no bare duplicate)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    expect(send).toBeDisabled()
    // switching the signal is also a real change → re-armed
    fireEvent.click(screen.getByRole('button', { name: /thumbs down/i }))
    expect(send).toBeEnabled()
  })

  it('keeps Send disabled after a noted rating send (post-clear bare draft is fingerprinted), re-arming only on a real change', async () => {
    render(<TripFeedbackPanel tripId="trip-1" />)
    fireEvent.click(screen.getByRole('radio', { name: '4 stars' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'great route' } })
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }))
    await waitFor(() => expect(submitTripFeedback).toHaveBeenCalledTimes(1))
    // note cleared → drops to the bare {rating:4}, which is already the fingerprint → Send OFF
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''))
    const send = screen.getByRole('button', { name: /send feedback/i })
    expect(send).toBeDisabled()
    // the 4-star rating survives the success
    expect(screen.getByRole('radio', { name: '4 stars' })).toHaveAttribute('aria-checked', 'true')
    // typing a new note is a real change → re-armed
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'actually, one gripe' } })
    expect(send).toBeEnabled()
    // clearing it back returns to the fingerprinted bare rating → disabled again
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '' } })
    expect(send).toBeDisabled()
    // switching to a different rating is a real change → re-armed
    fireEvent.click(screen.getByRole('radio', { name: '5 stars' }))
    expect(send).toBeEnabled()
  })

  // 7a — honest pending
  it('shows an honest pending state (disabled controls, "Sending…", aria-busy) while in flight', async () => {
    let resolveSend!: (v: TripFeedbackResponse) => void
    submitTripFeedback.mockReturnValue(
      new Promise<TripFeedbackResponse>((resolve) => {
        resolveSend = resolve
      }),
    )
    const { container } = render(<TripFeedbackPanel tripId="trip-1" />)
    fireEvent.click(screen.getByRole('button', { name: /thumbs up/i }))
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /sending…/i })).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: /sending…/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /thumbs up/i })).toBeDisabled()
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    resolveSend(row())
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /send feedback/i })).toBeInTheDocument(),
    )
  })

  // 7b — two clicks in ONE act() batch → exactly one call. Only the inFlight ref can stop the
  // second call (the disabled attribute has not re-rendered inside the same synchronous batch).
  it('fires exactly one request when Send is double-clicked in the same batch (inFlight ref)', async () => {
    submitTripFeedback.mockReturnValue(new Promise<TripFeedbackResponse>(() => {}))
    render(<TripFeedbackPanel tripId="trip-1" />)
    fireEvent.click(screen.getByRole('button', { name: /thumbs up/i }))
    const send = screen.getByRole('button', { name: /send feedback/i })
    await act(async () => {
      send.click()
      send.click()
    })
    expect(submitTripFeedback).toHaveBeenCalledTimes(1)
  })

  // 8 — session-expired, both branches, distinct from the generic copy
  it('shows the sign-in copy when the session is missing at token time, without calling the API', async () => {
    getAccessToken.mockRejectedValue(new Error('Not signed in'))
    render(<TripFeedbackPanel tripId="trip-1" />)
    fireEvent.click(screen.getByRole('button', { name: /thumbs up/i }))
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }))
    await waitFor(() =>
      expect(screen.getByText(/session expired — sign in again\./i)).toBeInTheDocument(),
    )
    expect(submitTripFeedback).not.toHaveBeenCalled()
  })

  it('shows the sign-in copy on a 401 mid-flight', async () => {
    submitTripFeedback.mockRejectedValue(new ApiError(401, 'unauthorized', 'nope'))
    render(<TripFeedbackPanel tripId="trip-1" />)
    fireEvent.click(screen.getByRole('button', { name: /thumbs up/i }))
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }))
    await waitFor(() =>
      expect(screen.getByText(/session expired — sign in again\./i)).toBeInTheDocument(),
    )
    expect(submitTripFeedback).toHaveBeenCalledTimes(1)
  })

  // 9 — network TypeError → generic copy; prior confirmed state + note survive
  it('shows the generic copy on a network TypeError and preserves prior confirmed state and note', async () => {
    submitTripFeedback.mockResolvedValueOnce(row({ feedback_type: 'thumbs_up' }))
    render(<TripFeedbackPanel tripId="trip-1" />)
    fireEvent.click(screen.getByRole('button', { name: /thumbs up/i }))
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }))
    expect(await screen.findByText(/saved: thumbs up/i)).toBeInTheDocument()
    // a follow-up send fails at the transport layer (not an ApiError)
    submitTripFeedback.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'follow-up note' } })
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }))
    await waitFor(() =>
      expect(screen.getByText(/couldn.t send that\. try again\./i)).toBeInTheDocument(),
    )
    expect(screen.getByText(/saved: thumbs up/i)).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveValue('follow-up note')
  })

  // key-reset (T3 test paragraph): re-keying to a different trip remounts and clears the selection
  it('resets the composer selection when re-keyed to a different trip', () => {
    const { rerender } = render(<TripFeedbackPanel key="trip-a" tripId="trip-a" />)
    fireEvent.click(screen.getByRole('button', { name: /thumbs up/i }))
    expect(screen.getByRole('button', { name: /thumbs up/i })).toHaveAttribute('aria-pressed', 'true')
    rerender(<TripFeedbackPanel key="trip-b" tripId="trip-b" />)
    expect(screen.getByRole('button', { name: /thumbs up/i })).toHaveAttribute('aria-pressed', 'false')
  })
})
