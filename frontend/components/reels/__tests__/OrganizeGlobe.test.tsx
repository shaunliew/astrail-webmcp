import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, render, screen, cleanup } from '@testing-library/react'
import OrganizeGlobe from '@/components/reels/OrganizeGlobe'

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('OrganizeGlobe', () => {
  it('SHOWS the real job status, not a decorative word', () => {
    /* It used to cycle "Stargazing…" / "Connecting the dots…" on a timer — explicitly cosmetic,
       explicitly not a progress claim — while the real status rode an sr-only region. So a screen
       reader was told what was happening and a sighted user was not, for 60-180 seconds, on the
       screen a judge sits through. */
    render(<OrganizeGlobe message="Reading your Reels" />)
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Reading your Reels')
    expect(status.className).not.toContain('sr-only')
  })

  it('announces the status to screen readers too, from the same element', () => {
    // One element, seen and heard: a visible copy plus a separate sr-only copy would double it up.
    render(<OrganizeGlobe message="Pinning places" />)
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByRole('status')).toHaveAttribute('aria-atomic', 'true')
    expect(screen.getAllByText('Pinning places')).toHaveLength(1)
  })

  it('keeps the live-region element itself mounted across status changes', () => {
    /* The fade is restarted by keying an INNER span. Keying the element that carries
       role="status" remounts the live region, and a freshly inserted one is not reliably
       announced — which would have quietly regressed the screen-reader users who were the only
       people this screen served before it showed anything at all. */
    const view = render(<OrganizeGlobe message="Reading your Reels" />)
    const first = screen.getByRole('status')
    view.rerender(<OrganizeGlobe message="Pinning places" />)
    expect(screen.getByRole('status')).toBe(first)          // same node, new text
    expect(screen.getByRole('status')).toHaveTextContent('Pinning places')
  })

  it('shows no invented progress words', () => {
    render(<OrganizeGlobe message="Reading your Reels" />)
    for (const word of ['Stargazing', 'Connecting the dots', 'Plotting your trail']) {
      expect(screen.queryByText(new RegExp(word, 'i'))).toBeNull()
    }
  })

  it('counts elapsed time so a slow stage still reads as alive', () => {
    // Measured, not predicted: unlike a percentage or an ETA it cannot be wrong, and it keeps
    // moving while one long stage holds the message still.
    vi.useFakeTimers()
    render(<OrganizeGlobe message="Working" />)
    expect(screen.getByText(/^0s/)).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(5000) })
    expect(screen.getByText(/^5s/)).toBeInTheDocument()
  })

  it('reads minutes and seconds past a minute, not 85s', () => {
    vi.useFakeTimers()
    render(<OrganizeGlobe message="Working" />)
    act(() => { vi.advanceTimersByTime(85_000) })
    expect(screen.getByText(/^1m 25s/)).toBeInTheDocument()
  })

  it('sets expectations for the wait', () => {
    // A number with no scale invites "is 90 seconds wrong?". The range is the honest answer.
    render(<OrganizeGlobe message="Working" />)
    expect(screen.getByText(/1–3 minutes/)).toBeInTheDocument()
  })
})
