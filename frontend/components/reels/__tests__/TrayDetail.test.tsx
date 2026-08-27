import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type ComponentProps } from 'react'

import TrayDetail from '@/components/reels/TrayDetail'
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
    id: 'c1', user_id: 'u1', name: 'Tokyo winter', sort_order: 0,
    created_at: '2026-07-18T00:00:00Z', updated_at: '2026-07-18T00:00:00Z', ...over,
  }
}

type Props = ComponentProps<typeof TrayDetail>

function setup(over: Partial<Props> = {}) {
  const props: Props = {
    collection: collection({}),
    cards: [],
    existingNames: [],
    onRemoveReel: vi.fn(async () => {}),
    onRename: vi.fn(async () => {}),
    onDelete: vi.fn(async () => {}),
    onCreateTrail: vi.fn(),
    onBack: vi.fn(),
    ...over,
  }
  return { ...render(<TrayDetail {...props} />), props }
}

describe('TrayDetail', () => {
  afterEach(() => cleanup())

  it('renders one row per member card', () => {
    setup({ cards: [card({ id: 'r1', caption: 'Tokyo Tower' }), card({ id: 'r2', caption: 'Shibuya' })] })

    expect(screen.getByText('Tokyo Tower')).toBeInTheDocument()
    expect(screen.getByText('Shibuya')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(2)
  })

  it('shows an empty-tray message when there are no reels', () => {
    setup({ cards: [] })
    expect(screen.getByText(/no reels in this tray yet/i)).toBeInTheDocument()
  })

  it('fires onRemoveReel with the card id when Remove is clicked', async () => {
    const { props } = setup({ cards: [card({ id: 'r1', caption: 'Tokyo Tower' })] })

    fireEvent.click(screen.getByRole('button', { name: 'Remove Tokyo Tower' }))

    await waitFor(() => expect(props.onRemoveReel).toHaveBeenCalledWith('r1'))
  })

  it('keeps the row and shows an inline error when a remove rejects (pessimistic)', async () => {
    setup({
      cards: [card({ id: 'r1', caption: 'Tokyo Tower' })],
      onRemoveReel: vi.fn().mockRejectedValue(new Error('remove failed')),
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove Tokyo Tower' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('remove failed')
    expect(screen.getByText('Tokyo Tower')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Tokyo Tower' })).not.toBeDisabled()
  })

  it('fires onRename with a trimmed name', async () => {
    const { props } = setup({ collection: collection({ name: 'Old' }) })

    fireEvent.click(screen.getByRole('button', { name: /^rename$/i }))
    fireEvent.change(screen.getByLabelText(/tray name/i), { target: { value: '  Renamed tray  ' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(props.onRename).toHaveBeenCalledWith('Renamed tray'))
  })

  it('rejects empty / whitespace / too-long / duplicate rename names client-side with no call', () => {
    const { props } = setup({ collection: collection({ name: 'Old' }), existingNames: ['Kyoto autumn'] })

    fireEvent.click(screen.getByRole('button', { name: /^rename$/i }))
    const input = screen.getByLabelText(/tray name/i)
    const save = screen.getByRole('button', { name: /^save$/i })

    fireEvent.change(input, { target: { value: '' } })
    expect(save).toBeDisabled()
    fireEvent.change(input, { target: { value: '   ' } })
    expect(save).toBeDisabled()
    fireEvent.change(input, { target: { value: 'a'.repeat(81) } })
    expect(save).toBeDisabled()
    fireEvent.change(input, { target: { value: 'kyoto autumn' } }) // case-insensitive dup
    expect(save).toBeDisabled()
    expect(screen.getByText(/already used/i)).toBeInTheDocument()

    fireEvent.click(save)
    expect(props.onRename).not.toHaveBeenCalled()
  })

  it('updates the shown name after a successful rename', async () => {
    const onRename = vi.fn(async (_name: string) => {})
    function Harness() {
      const [name, setName] = useState('Old name')
      return (
        <TrayDetail
          collection={collection({ name })}
          cards={[]}
          existingNames={[]}
          onRemoveReel={vi.fn(async () => {})}
          onRename={async (n) => { await onRename(n); setName(n) }}
          onDelete={vi.fn(async () => {})}
          onCreateTrail={vi.fn()}
          onBack={vi.fn()}
        />
      )
    }
    render(<Harness />)

    expect(screen.getByRole('heading', { name: 'Old name' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^rename$/i }))
    fireEvent.change(screen.getByLabelText(/tray name/i), { target: { value: 'New name' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(onRename).toHaveBeenCalledWith('New name'))
    expect(await screen.findByRole('heading', { name: 'New name' })).toBeInTheDocument()
  })

  it('fires onDelete after the delete is confirmed', async () => {
    const { props } = setup({})

    fireEvent.click(screen.getByRole('button', { name: /delete tray/i }))
    fireEvent.click(screen.getByRole('button', { name: /confirm delete/i }))

    await waitFor(() => expect(props.onDelete).toHaveBeenCalledTimes(1))
  })

  it('disables every mutation control including Create trail while a mutation is pending', async () => {
    let resolveRemove!: () => void
    const onRemoveReel = vi.fn(() => new Promise<void>((resolve) => { resolveRemove = resolve }))
    setup({
      cards: [card({ id: 'r1', caption: 'A', places: [place({})] }), card({ id: 'r2', caption: 'B' })],
      onRemoveReel,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Remove A' }))
    await waitFor(() => expect(onRemoveReel).toHaveBeenCalledTimes(1))

    expect(screen.getByRole('button', { name: 'Remove A' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove B' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^rename$/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /delete tray/i })).toBeDisabled()
    // Create trail is otherwise-enabled here (r1 has a grounded place), so a disabled state proves the lock.
    expect(screen.getByRole('button', { name: /create trail/i })).toBeDisabled()
    // Back is under the same lock (M1): it can't be used to escape-and-reopen a fresh unlocked instance.
    expect(screen.getByRole('button', { name: /^back$/i })).toBeDisabled()

    await act(async () => { resolveRemove(); await Promise.resolve() })
    expect(screen.getByRole('button', { name: 'Remove B' })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: /^back$/i })).not.toBeDisabled()
  })

  it('disables Create trail with an add-reels hint for an empty tray', () => {
    const { props } = setup({ cards: [] })

    const btn = screen.getByRole('button', { name: /create trail/i })
    expect(btn).toBeDisabled()
    expect(screen.getByText(/add reels to plan a trip/i)).toBeInTheDocument()

    fireEvent.click(btn)
    expect(props.onCreateTrail).not.toHaveBeenCalled()
  })

  it('disables Create trail with an organize hint when reels have no grounded places', () => {
    setup({ cards: [card({ id: 'r1', caption: 'A', places: [] })] })

    expect(screen.getByRole('button', { name: /create trail/i })).toBeDisabled()
    expect(screen.getByText(/organize these reels first to plan a trip/i)).toBeInTheDocument()
  })

  it('enables Create trail and fires onCreateTrail when the tray has grounded places', () => {
    const { props } = setup({ cards: [card({ id: 'r1', caption: 'A', places: [place({})] })] })

    const btn = screen.getByRole('button', { name: /create trail/i })
    expect(btn).not.toBeDisabled()

    fireEvent.click(btn)
    expect(props.onCreateTrail).toHaveBeenCalledTimes(1)
  })

  it('fires onBack when Back is clicked', () => {
    const { props } = setup({})
    fireEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(props.onBack).toHaveBeenCalledTimes(1)
  })

  it('keeps the rename form open and preserves the typed value when a rename rejects', async () => {
    setup({ collection: collection({ name: 'Old' }), onRename: vi.fn().mockRejectedValue(new Error('rename failed')) })

    fireEvent.click(screen.getByRole('button', { name: /^rename$/i }))
    fireEvent.change(screen.getByLabelText(/tray name/i), { target: { value: 'New name' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('rename failed')
    // The form stays open with the typed value preserved (not reset to the old name), lock released.
    expect(screen.getByLabelText(/tray name/i)).toHaveValue('New name')
    expect(screen.getByLabelText(/tray name/i)).not.toBeDisabled()
  })

  it('keeps the delete confirm open with an inline error when a delete rejects', async () => {
    setup({ onDelete: vi.fn().mockRejectedValue(new Error('delete failed')) })

    fireEvent.click(screen.getByRole('button', { name: /delete tray/i }))
    fireEvent.click(screen.getByRole('button', { name: /confirm delete/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('delete failed')
    // The confirm stays open so the user can retry.
    expect(screen.getByRole('button', { name: /confirm delete/i })).toBeInTheDocument()
  })

  it('shows a loading placeholder (not an empty-tray message) while cards are still loading (M3)', () => {
    setup({ cards: [], cardsStatus: 'loading' })
    expect(screen.getByText(/loading this tray's reels/i)).toBeInTheDocument()
    expect(screen.queryByText(/no reels in this tray yet/i)).not.toBeInTheDocument()
  })

  it("shows an error placeholder when the tray's cards failed to load (M3)", () => {
    setup({ cards: [], cardsStatus: 'error' })
    expect(screen.getByText(/could not load this tray's reels/i)).toBeInTheDocument()
    expect(screen.queryByText(/no reels in this tray yet/i)).not.toBeInTheDocument()
  })

  it('keeps the genuine empty-tray message when cards are ready (M3 regression)', () => {
    setup({ cards: [], cardsStatus: 'ready' })
    expect(screen.getByText(/no reels in this tray yet/i)).toBeInTheDocument()
  })

  it('shows the member count in the header even while cards are still loading (M3, Codex nit)', () => {
    setup({ cards: [], memberCount: 2, cardsStatus: 'loading' })
    // Header count comes from membership, not resolved cards — so it reads "2 reels", not "0 reels".
    expect(
      screen.getByText((_c, el) => el?.tagName === 'P' && el.textContent?.replace(/\s+/g, ' ').trim() === '2 reels'),
    ).toBeInTheDocument()
    expect(screen.getByText(/loading this tray's reels/i)).toBeInTheDocument()
  })

  it('badges each member row by URL kind and titles a caption-less card kind-aware', () => {
    setup({
      cards: [
        card({ id: 'p1', normalized_url: 'https://www.instagram.com/p/POST123/', caption: null, personal_label: null }),
        card({ id: 'r1', normalized_url: 'https://www.instagram.com/reel/REEL123/', caption: null, personal_label: null }),
      ],
    })

    // Shared sourceLabel badge on each row…
    expect(screen.getByText('Post')).toBeInTheDocument()
    expect(screen.getByText('Reel')).toBeInTheDocument()
    // …and the untitled fallback follows the URL kind.
    expect(screen.getByText('Untitled post')).toBeInTheDocument()
    expect(screen.getByText('Untitled reel')).toBeInTheDocument()
  })
})

describe('TrayDetail: the "organize these first" dead end', () => {
  /* "Create trail" was disabled with the hint "Organize these reels first to plan a trip." and no
     way to do it. The user had to independently know to leave, open the library, select the same
     reels, and organize them there. The tray already knows which of its reels have no places. */
  const noPlaces = (id: string): SavedReelCard => ({
    id, user_id: 'u1', normalized_url: `https://www.instagram.com/reel/${id}`,
    source_platform: 'instagram', reel_cache_id: null, has_current_cache: false,
    analysis_status: 'not_analyzed', personal_label: null, retry_after: null, analyzed_at: null,
    created_at: '2026-08-27T00:00:00Z', updated_at: '2026-08-27T00:00:00Z',
    caption: null, thumbnail_url: null, places: [],
  })

  const tray = { id: 'c1', user_id: 'u1', name: 'Tokyo', created_at: '', updated_at: '' } as never

  it('offers to find the places, instead of telling you to go elsewhere', async () => {
    const onOrganize = vi.fn().mockResolvedValue(undefined)
    render(
      <TrayDetail
        collection={tray} cards={[noPlaces('r1'), noPlaces('r2')]} existingNames={[]}
        onRemoveReel={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()}
        onCreateTrail={vi.fn()} onOrganize={onOrganize} onBack={vi.fn()}
      />,
    )
    const button = await screen.findByRole('button', { name: /find places in 2 reels/i })
    fireEvent.click(button)
    await waitFor(() => expect(onOrganize).toHaveBeenCalledWith(['r1', 'r2']))
  })

  it('keeps the old wording when the screen cannot organize', async () => {
    // Without the capability, naming the blocker is still better than silence.
    render(
      <TrayDetail
        collection={tray} cards={[noPlaces('r1')]} existingNames={[]}
        onRemoveReel={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()}
        onCreateTrail={vi.fn()} onBack={vi.fn()}
      />,
    )
    expect(await screen.findByText(/organize these reels first/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /find places in/i })).toBeNull()
  })

  it('does not offer it once the tray has places to plan from', async () => {
    const withPlaces = {
      ...noPlaces('r1'),
      places: [{ place_id: 'p1', name: 'X', lat: 1, lng: 1, country_code: 'JP', country_name: 'Japan', evidence_quote: 'q', source_url: null, source_reel_url: 'u', confidence: 0.9 }],
    }
    render(
      <TrayDetail
        collection={tray} cards={[withPlaces]} existingNames={[]}
        onRemoveReel={vi.fn()} onRename={vi.fn()} onDelete={vi.fn()}
        onCreateTrail={vi.fn()} onOrganize={vi.fn()} onBack={vi.fn()}
      />,
    )
    await screen.findByRole('button', { name: /create trail/i })
    expect(screen.queryByRole('button', { name: /find places in/i })).toBeNull()
  })
})
