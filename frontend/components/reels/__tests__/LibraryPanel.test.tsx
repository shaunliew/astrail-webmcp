import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// The card-fan carousel drives its layout with gsap inside a useEffect. jsdom has no real
// layout/RAF, so no-op gsap keeps the fan from flaking and leaves its card buttons
// synchronously clickable for the browse-tap assertion.
vi.mock('gsap', () => ({
  default: { to: vi.fn(), set: vi.fn(), killTweensOf: vi.fn() },
}))

import LibraryPanel from '@/components/reels/LibraryPanel'
import type { SavedReelCard, SavedReelPlaceProof } from '@/lib/reels/backend-types'

function place(over: Partial<SavedReelPlaceProof>): SavedReelPlaceProof {
  return {
    place_id: 'p1', name: 'Place', lat: 0, lng: 0, country_code: 'JP', country_name: 'Japan',
    evidence_quote: 'q', source_url: null, source_reel_url: 'https://ig/reel/x', confidence: 1, ...over,
  }
}

function card(over: Partial<SavedReelCard>): SavedReelCard {
  return {
    id: 'r1', user_id: 'u1', normalized_url: 'https://ig/reel/r1', source_platform: 'instagram',
    reel_cache_id: null, analysis_status: 'not_analyzed', personal_label: null, retry_after: null,
    analyzed_at: null, created_at: '2026-07-18T00:00:00Z', updated_at: '2026-07-18T00:00:00Z',
    caption: null, thumbnail_url: null, has_current_cache: false, places: [], ...over,
  }
}

const noop = async () => {}
const toSelect = () => fireEvent.click(screen.getByRole('button', { name: /^select$/i }))

describe('LibraryPanel', () => {
  afterEach(() => { cleanup() })

  it('narrows the list to a chosen country filter chip', () => {
    const jp = card({ id: 'jp', caption: 'Tokyo Tower', places: [place({ country_code: 'JP', country_name: 'Japan', name: 'Tokyo Tower' })] })
    const kr = card({ id: 'kr', caption: 'Myeongdong', places: [place({ country_code: 'KR', country_name: 'South Korea', name: 'Myeongdong' })] })

    render(<LibraryPanel cards={[jp, kr]} onClose={vi.fn()} onOpenReel={vi.fn()} onOrganize={noop} />)
    toSelect()

    expect(screen.getByText('Tokyo Tower')).toBeInTheDocument()
    expect(screen.getByText('Myeongdong')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Japan' }))

    expect(screen.getByText('Tokyo Tower')).toBeInTheDocument()
    expect(screen.queryByText('Myeongdong')).not.toBeInTheDocument()
  })

  it('narrows the list by search across caption, personal_label and place names', () => {
    const a = card({ id: 'a', caption: 'Sunset above the bay', places: [place({ name: 'Tokyo Tower' })] })
    const b = card({ id: 'b', caption: null, personal_label: 'Kyoto trip', places: [place({ name: 'Fushimi Inari' })] })

    render(<LibraryPanel cards={[a, b]} onClose={vi.fn()} onOpenReel={vi.fn()} onOrganize={noop} />)
    toSelect()

    const search = screen.getByLabelText(/search/i)

    fireEvent.change(search, { target: { value: 'sunset' } }) // caption
    expect(screen.getByText('Sunset above the bay')).toBeInTheDocument()
    expect(screen.queryByText('Kyoto trip')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'inari' } }) // place name
    expect(screen.getByText('Kyoto trip')).toBeInTheDocument()
    expect(screen.queryByText('Sunset above the bay')).not.toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'KYOTO' } }) // personal_label, case-insensitive
    expect(screen.getByText('Kyoto trip')).toBeInTheDocument()
    expect(screen.queryByText('Sunset above the bay')).not.toBeInTheDocument()
  })

  it('fires onOpenReel with the matching card when a fan card is tapped in browse mode', () => {
    const onOpenReel = vi.fn()
    const target = card({ id: 'r7', caption: 'Osaka nights', thumbnail_url: 'https://img.test/osaka.jpg' })

    render(<LibraryPanel cards={[target]} onClose={vi.fn()} onOpenReel={onOpenReel} onOrganize={noop} />)

    // Browse is the default mode; the fan renders the reel as a button named by its alt.
    fireEvent.click(screen.getByRole('button', { name: /osaka nights/i }))

    expect(onOpenReel).toHaveBeenCalledTimes(1)
    expect(onOpenReel).toHaveBeenCalledWith(target)
  })

  it('organizes selected reels through onOrganize and caps the selection at five', async () => {
    const onOrganize = vi.fn(async () => {})
    const cards = Array.from({ length: 6 }, (_, i) => card({ id: `r${i}`, caption: `Reel ${i}` }))

    render(<LibraryPanel cards={cards} onClose={vi.fn()} onOpenReel={vi.fn()} onOrganize={onOrganize} />)
    toSelect()

    for (let i = 0; i < 6; i++) {
      fireEvent.click(screen.getByRole('button', { name: `Select Reel ${i}` }))
    }

    // The sixth pick is blocked at the cap of five.
    expect(screen.getByText('5 / 5 selected')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^plan a trip$/i }))

    await waitFor(() => expect(onOrganize).toHaveBeenCalledWith(['r0', 'r1', 'r2', 'r3', 'r4']))
  })

  it('shows a place count for an analyzed card and a status for an unanalyzed one', () => {
    const analyzed = card({ id: 'a', caption: 'Has places', places: [place({ place_id: 'p1' }), place({ place_id: 'p2' })] })
    const raw = card({ id: 'b', caption: 'Fresh save', analysis_status: 'not_analyzed', places: [] })

    render(<LibraryPanel cards={[analyzed, raw]} onClose={vi.fn()} onOpenReel={vi.fn()} onOrganize={noop} />)
    toSelect()

    expect(screen.getByText('Places found · 2')).toBeInTheDocument()
    expect(screen.getByText('Not analyzed')).toBeInTheDocument()
  })

  it('clears an active country filter when the All chip is clicked', () => {
    const jp = card({ id: 'jp', caption: 'Tokyo Tower', places: [place({ country_code: 'JP', country_name: 'Japan', name: 'Tokyo Tower' })] })
    const kr = card({ id: 'kr', caption: 'Myeongdong', places: [place({ country_code: 'KR', country_name: 'South Korea', name: 'Myeongdong' })] })

    render(<LibraryPanel cards={[jp, kr]} onClose={vi.fn()} onOpenReel={vi.fn()} onOrganize={noop} />)
    toSelect()

    fireEvent.click(screen.getByRole('button', { name: 'Japan' }))
    expect(screen.getByText('Tokyo Tower')).toBeInTheDocument()
    expect(screen.queryByText('Myeongdong')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByText('Tokyo Tower')).toBeInTheDocument()
    expect(screen.getByText('Myeongdong')).toBeInTheDocument()
  })

  it('lists a multi-country card under every one of its country chips', () => {
    const multi = card({
      id: 'multi',
      caption: 'Tokyo to Seoul',
      places: [
        place({ place_id: 'p1', country_code: 'JP', country_name: 'Japan', name: 'Tokyo Tower' }),
        place({ place_id: 'p2', country_code: 'KR', country_name: 'South Korea', name: 'Myeongdong' }),
      ],
    })
    const other = card({ id: 'other', caption: 'Bali beach', places: [place({ place_id: 'p3', country_code: 'ID', country_name: 'Indonesia', name: 'Kuta' })] })

    render(<LibraryPanel cards={[multi, other]} onClose={vi.fn()} onOpenReel={vi.fn()} onOrganize={noop} />)
    toSelect()

    fireEvent.click(screen.getByRole('button', { name: 'Japan' }))
    expect(screen.getByText('Tokyo to Seoul')).toBeInTheDocument()
    expect(screen.queryByText('Bali beach')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'South Korea' }))
    expect(screen.getByText('Tokyo to Seoul')).toBeInTheDocument()
    expect(screen.queryByText('Bali beach')).not.toBeInTheDocument()
  })

  it('reads "Places found · 0" for an organized card with no grounded places', () => {
    const organized = card({ id: 'o', caption: 'Organized but empty', analysis_status: 'organized', places: [] })

    render(<LibraryPanel cards={[organized]} onClose={vi.fn()} onOpenReel={vi.fn()} onOrganize={noop} />)
    toSelect()

    expect(screen.getByText('Places found · 0')).toBeInTheDocument()
  })

  it('skips the catch body when onOrganize rejects after unmount (unmount guard)', async () => {
    // Failing journey: user clicks "Plan a trip" (busy, onOrganize in flight) then "Back"
    // (parent unmounts the panel); onOrganize rejects afterward. React 19 silently drops a
    // setState on an unmounted fiber (no console warning), so we observe the activeRef guard
    // through the only value organize()'s catch reads from the rejection — err.message. The
    // guarded catch runs `if (activeRef.current) { setMessage(err.message); setBusy(false) }`,
    // so post-unmount the getter must never fire; without the guard it does.
    let rejectOrganize!: (err: unknown) => void
    const onOrganize = vi.fn(() => new Promise<void>((_, reject) => { rejectOrganize = reject }))
    const err = new Error()
    let messageReads = 0
    Object.defineProperty(err, 'message', { configurable: true, get() { messageReads++; return 'boom' } })

    const { unmount } = render(
      <LibraryPanel cards={[card({ id: 'r1', caption: 'Reel 1' })]} onClose={vi.fn()} onOpenReel={vi.fn()} onOrganize={onOrganize} />,
    )
    toSelect()
    fireEvent.click(screen.getByRole('button', { name: 'Select Reel 1' }))
    fireEvent.click(screen.getByRole('button', { name: /^plan a trip$/i }))

    await waitFor(() => expect(onOrganize).toHaveBeenCalledTimes(1))

    unmount() // Back mid-flight — the panel is gone before onOrganize settles.

    await act(async () => {
      rejectOrganize(err)
      await Promise.resolve()
    })

    // Guard skipped the catch body entirely: the rejection was never inspected.
    expect(messageReads).toBe(0)
  })

  it('surfaces the error message while still mounted when onOrganize rejects', async () => {
    const onOrganize = vi.fn(async () => { throw new Error('Could not reach the planner.') })

    render(<LibraryPanel cards={[card({ id: 'r1', caption: 'Reel 1' })]} onClose={vi.fn()} onOpenReel={vi.fn()} onOrganize={onOrganize} />)
    toSelect()
    fireEvent.click(screen.getByRole('button', { name: 'Select Reel 1' }))
    fireEvent.click(screen.getByRole('button', { name: /^plan a trip$/i }))

    // Guard's true branch: mounted → the catch shows the message and re-enables the button.
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the planner.')
    expect(screen.getByRole('button', { name: /^plan a trip$/i })).not.toBeDisabled()
  })

  it('returns to the trays home via the back control', () => {
    const onClose = vi.fn()
    render(<LibraryPanel cards={[]} onClose={onClose} onOpenReel={vi.fn()} onOrganize={noop} />)

    fireEvent.click(screen.getByRole('button', { name: /back/i }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
