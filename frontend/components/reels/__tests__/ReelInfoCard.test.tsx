import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'

import ReelInfoCard from '@/components/reels/ReelInfoCard'
import type { ReelCollection, SavedReelCard, SavedReelPlaceProof } from '@/lib/reels/backend-types'

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

function collection(over: Partial<ReelCollection>): ReelCollection {
  return {
    id: 't1', user_id: 'u1', name: 'Tray', sort_order: 0,
    created_at: '2026-07-18T00:00:00Z', updated_at: '2026-07-18T00:00:00Z', ...over,
  }
}

type Props = ComponentProps<typeof ReelInfoCard>

function setup(over: Partial<Props> = {}) {
  const props: Props = {
    card: card({}),
    collections: [],
    traysState: 'ready',
    traysWithReel: new Set<string>(),
    onAddToTray: vi.fn(async () => {}),
    onRequestNewTray: vi.fn(),
    onClose: vi.fn(),
    ...over,
  }
  return { ...render(<ReelInfoCard {...props} />), props }
}

const trayRow = (name: RegExp) => screen.getByRole('button', { name })

describe('ReelInfoCard', () => {
  afterEach(() => cleanup())

  it('renders one place row per place in a multi-place card', () => {
    setup({
      card: card({
        places: [
          place({ place_id: 'p1', name: 'Tokyo Tower' }),
          place({ place_id: 'p2', name: 'Shibuya Crossing' }),
          place({ place_id: 'p3', name: 'Kyoto Station' }),
        ],
      }),
    })

    expect(screen.getAllByTestId('place-pin')).toHaveLength(3)
    expect(screen.getByText('Tokyo Tower')).toBeInTheDocument()
    expect(screen.getByText('Shibuya Crossing')).toBeInTheDocument()
    expect(screen.getByText('Kyoto Station')).toBeInTheDocument()
  })

  it('fires onAddToTray with the collection id when a ready tray row is clicked', async () => {
    const { props } = setup({ collections: [collection({ id: 't1', name: 'Japan trip' })] })

    fireEvent.click(trayRow(/Japan trip/i))

    await waitFor(() => expect(props.onAddToTray).toHaveBeenCalledWith('t1'))
  })

  it('shows Added + disabled for a tray already holding the reel and does not fire onAddToTray', () => {
    const { props } = setup({
      collections: [collection({ id: 't1', name: 'Japan trip' })],
      traysWithReel: new Set(['t1']),
    })

    const row = trayRow(/Japan trip/i)
    expect(row).toHaveTextContent(/Added/)
    expect(row).toBeDisabled()

    fireEvent.click(row)
    expect(props.onAddToTray).not.toHaveBeenCalled()
  })

  it('optimistically flips the row to Added on success even though traysWithReel never changes (C1)', async () => {
    const { props } = setup({
      collections: [collection({ id: 't1', name: 'Japan trip' })],
      onAddToTray: vi.fn().mockResolvedValue(undefined),
    })

    fireEvent.click(trayRow(/Japan trip/i))

    await waitFor(() => expect(props.onAddToTray).toHaveBeenCalledWith('t1'))
    await waitFor(() => expect(trayRow(/Japan trip/i)).toHaveTextContent(/Added/))
    expect(trayRow(/Japan trip/i)).toBeDisabled()
  })

  it('shows an inline error and does NOT mark Added when onAddToTray rejects', async () => {
    setup({
      collections: [collection({ id: 't1', name: 'Japan trip' })],
      onAddToTray: vi.fn().mockRejectedValue(new Error('write failed')),
    })

    fireEvent.click(trayRow(/Japan trip/i))

    expect(await screen.findByRole('alert')).toHaveTextContent('write failed')
    const row = trayRow(/Japan trip/i)
    expect(row).not.toHaveTextContent('Added')
    expect(row).not.toBeDisabled()
  })

  it('distinguishes loading / error / genuinely-empty tray states (C1)', () => {
    const loading = setup({ collections: [], traysState: 'loading' })
    expect(screen.getByText(/Loading your trays/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /New tray/i })).not.toBeInTheDocument()
    loading.unmount()

    const errored = setup({ collections: [], traysState: 'error' })
    expect(screen.getByText(/Couldn't load your trays/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /New tray/i })).toBeInTheDocument()
    errored.unmount()

    setup({ collections: [], traysState: 'ready' })
    expect(screen.getByRole('button', { name: /New tray/i })).toBeInTheDocument()
    expect(screen.queryByText(/Loading your trays/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Couldn't load your trays/i)).not.toBeInTheDocument()
  })

  it('keeps the tray list + optimistic Added when a refresh fails after ready (C1 error-path)', async () => {
    const { rerender, props } = setup({
      collections: [collection({ id: 't1', name: 'Japan trip' }), collection({ id: 't2', name: 'Osaka' })],
      traysState: 'ready',
      onAddToTray: vi.fn().mockResolvedValue(undefined),
    })

    fireEvent.click(trayRow(/Japan trip/i))
    await waitFor(() => expect(trayRow(/Japan trip/i)).toHaveTextContent(/Added/))

    // refresh() fails AFTER the successful add → parent flips traysState to 'error'.
    rerender(<ReelInfoCard {...props} traysState="error" />)

    // The list is NOT replaced by the load-error; the rows + the optimistic Added survive,
    // shown alongside a non-blocking refresh notice instead.
    expect(screen.queryByText(/Couldn't load your trays/i)).not.toBeInTheDocument()
    expect(trayRow(/Japan trip/i)).toHaveTextContent(/Added/)
    expect(screen.getByText('Osaka')).toBeInTheDocument()
    expect(screen.getByText(/Couldn't refresh your trays/i)).toBeInTheDocument()
  })

  it('serializes adds via one global lock: all rows disabled while pending, no second call (C3)', async () => {
    let resolveAdd!: () => void
    const onAddToTray = vi.fn(() => new Promise<void>((resolve) => { resolveAdd = resolve }))
    setup({
      collections: [collection({ id: 'a', name: 'Tray A' }), collection({ id: 'b', name: 'Tray B' })],
      onAddToTray,
    })

    fireEvent.click(trayRow(/Tray A/i))
    await waitFor(() => expect(onAddToTray).toHaveBeenCalledTimes(1))

    expect(trayRow(/Tray A/i)).toBeDisabled()
    expect(trayRow(/Tray B/i)).toBeDisabled()
    expect(screen.getByRole('button', { name: /New tray/i })).toBeDisabled()

    fireEvent.click(trayRow(/Tray B/i))
    expect(onAddToTray).toHaveBeenCalledTimes(1)

    await act(async () => { resolveAdd(); await Promise.resolve() })

    expect(trayRow(/Tray A/i)).toHaveTextContent(/Added/)
    expect(trayRow(/Tray B/i)).not.toBeDisabled()
    expect(screen.getByRole('button', { name: /New tray/i })).not.toBeDisabled()
  })

  it('labels a reel card "View Reel" with a Reel kind badge', () => {
    setup({ card: card({ normalized_url: 'https://www.instagram.com/reel/R1/' }) })
    expect(screen.getByRole('link', { name: /view reel/i })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /view post/i })).not.toBeInTheDocument()
    expect(screen.getByText('Reel')).toBeInTheDocument()
  })

  it('labels a /p/ post card "View post" with a Post kind badge', () => {
    setup({ card: card({ normalized_url: 'https://www.instagram.com/p/POST1/' }) })
    expect(screen.getByRole('link', { name: /view post/i })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /view reel/i })).not.toBeInTheDocument()
    expect(screen.getByText('Post')).toBeInTheDocument()
  })

  it('shows the empty state for a card with no places', () => {
    setup({ card: card({ places: [], analysis_status: 'location_not_found' }) })
    expect(screen.getByText(/No places found yet/i)).toBeInTheDocument()
  })

  it('calls onClose on document-level Escape and on a backdrop click', () => {
    const first = setup({})
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(first.props.onClose).toHaveBeenCalledTimes(1)
    first.unmount()

    const second = setup({})
    fireEvent.click(screen.getByRole('dialog').parentElement!)
    expect(second.props.onClose).toHaveBeenCalledTimes(1)
  })

  it('restores focus to the opener element on unmount (C2)', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)

    const { unmount } = setup({})
    expect(document.activeElement).not.toBe(opener) // close button autofocused

    unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('fires onRequestNewTray when New tray… is clicked', () => {
    const { props } = setup({ collections: [], traysState: 'ready' })
    fireEvent.click(screen.getByRole('button', { name: /New tray/i }))
    expect(props.onRequestNewTray).toHaveBeenCalledTimes(1)
  })
})
