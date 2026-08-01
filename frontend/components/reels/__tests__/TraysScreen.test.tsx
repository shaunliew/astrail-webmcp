import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const { getUser, listCollections, getMembershipsByCollection, createCollection, addReelsToCollection, renameCollection, deleteCollection, removeReelFromCollection } = vi.hoisted(() => ({
  getUser: vi.fn(async () => ({ data: { user: { email: 'zh@astrail.app', user_metadata: { full_name: 'Zhi Hao' } } } })),
  listCollections: vi.fn(),
  getMembershipsByCollection: vi.fn(),
  createCollection: vi.fn(),
  addReelsToCollection: vi.fn(),
  renameCollection: vi.fn(),
  deleteCollection: vi.fn(),
  removeReelFromCollection: vi.fn(),
}))

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ auth: { getUser } }) }))
vi.mock('@/lib/reels/collections', () => ({ listCollections, getMembershipsByCollection, createCollection, addReelsToCollection, renameCollection, deleteCollection, removeReelFromCollection }))
// Opening the Library swaps in LibraryPanel, whose card-fan drives gsap in a useEffect;
// no-op it so the fan cannot flake in jsdom during this integration test.
vi.mock('gsap', () => ({ default: { to: vi.fn(), set: vi.fn(), killTweensOf: vi.fn() } }))

import TraysScreen from '@/components/reels/TraysScreen'
import type { ReelCollection, SavedReelCard, SavedReelPlaceProof } from '@/lib/reels/backend-types'

function collection(over: Partial<ReelCollection>): ReelCollection {
  return {
    id: 'c1', user_id: 'u1', name: 'Tray', sort_order: 0,
    created_at: '2026-07-18T00:00:00Z', updated_at: '2026-07-18T00:00:00Z', ...over,
  }
}

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

// The tray count renders as an image icon + the number, with an sr-only unit — so
// "3" shows but a screen reader hears "3 reels". The visible number and the sr-only
// word live in separate nodes, so match the count <span> by its full text.
const countBadge = (label: string) =>
  screen.getByText(
    (_content, el) => el?.tagName === 'SPAN' && el.textContent?.replace(/\s+/g, ' ').trim() === label,
  )

describe('TraysScreen', () => {
  beforeEach(() => {
    getUser.mockClear()
    listCollections.mockReset(); listCollections.mockResolvedValue([])
    getMembershipsByCollection.mockReset(); getMembershipsByCollection.mockResolvedValue({})
    createCollection.mockReset()
    addReelsToCollection.mockReset()
    renameCollection.mockReset()
    deleteCollection.mockReset(); deleteCollection.mockResolvedValue(undefined)
    removeReelFromCollection.mockReset(); removeReelFromCollection.mockResolvedValue(undefined)
  })
  afterEach(() => { cleanup() })

  it('renders one tray per collection with its reel count from memberships', async () => {
    listCollections.mockResolvedValue([
      collection({ id: 'c1', name: 'Tokyo winter' }),
      collection({ id: 'c2', name: 'Korea Myeongdong' }),
    ])
    getMembershipsByCollection.mockResolvedValue({ c1: ['r1', 'r2'], c2: ['r1'] })
    const cards = [card({ id: 'r1', caption: 'Tokyo Tower' }), card({ id: 'r2', caption: 'Shibuya' })]

    render(<TraysScreen cards={cards} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)

    expect(await screen.findByRole('button', { name: 'Tokyo winter' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Korea Myeongdong' })).toBeInTheDocument()
    expect(countBadge('2 reels')).toBeInTheDocument()
    expect(countBadge('1 reel')).toBeInTheDocument()
  })

  it('renders an empty tray (zero memberships) with an Open control and a zero count', async () => {
    listCollections.mockResolvedValue([collection({ id: 'c2', name: 'Empty tray' })])
    getMembershipsByCollection.mockResolvedValue({})

    render(<TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)

    expect(await screen.findByRole('button', { name: 'Empty tray' })).toBeInTheDocument()
    expect(countBadge('0 reels')).toBeInTheDocument()
  })

  it('shows the create tile and the Library banner', async () => {
    listCollections.mockResolvedValue([collection({ id: 'c1', name: 'Tokyo winter' })])

    render(<TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)

    expect(await screen.findByRole('button', { name: 'Tokyo winter' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create a tray/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /your inspiration starts here/i })).toBeInTheDocument()
  })

  it('opens the Library panel from the banner as a full-surface swap and returns home on back', async () => {
    const cards = [card({ id: 'r1', caption: 'Tokyo Tower at sunset' })]

    render(<TraysScreen cards={cards} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: /your inspiration starts here/i }))

    // LibraryPanel replaces the home content — its header shows and the greeting is gone.
    expect(screen.getByText(/your saved reels live here/i)).toBeInTheDocument()
    expect(screen.queryByText(/welcome back/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /back/i }))

    expect(await screen.findByRole('button', { name: /your inspiration starts here/i })).toBeInTheDocument()
  })

  it('threads its own onOrganize through the Library select→plan flow', async () => {
    const onOrganize = vi.fn(async () => {})
    const cards = [card({ id: 'r1', caption: 'Tokyo Tower' }), card({ id: 'r2', caption: 'Shibuya' })]

    render(<TraysScreen cards={cards} onCapture={noop} onOrganize={onOrganize} onCreateTrail={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: /your inspiration starts here/i }))
    fireEvent.click(screen.getByRole('button', { name: /^select$/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Select Tokyo Tower' }))
    fireEvent.click(screen.getByRole('button', { name: /^plan a trip$/i }))

    await waitFor(() => expect(onOrganize).toHaveBeenCalledWith(['r1']))
  })

  it('captures a Reel URL through onCapture', async () => {
    const onCapture = vi.fn(async () => {})

    render(<TraysScreen cards={[]} onCapture={onCapture} onOrganize={noop} onCreateTrail={noop} />)

    fireEvent.change(screen.getByLabelText(/paste a reel link/i), {
      target: { value: 'https://www.instagram.com/reel/AAA/' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(onCapture).toHaveBeenCalledWith('https://www.instagram.com/reel/AAA/'))
  })

  it('shows the empty state when there are no reels and no trays', async () => {
    render(<TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)

    expect(await screen.findByText(/no trails yet/i)).toBeInTheDocument()
  })

  it('shows the error banner (not the empty state) when the trays fetch fails with no reels', async () => {
    listCollections.mockRejectedValue(new Error('network down'))

    render(<TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)

    // A transient listCollections failure must surface the error, not the misleading empty state.
    expect(await screen.findByText(/could not load your trays/i)).toBeInTheDocument()
    expect(screen.queryByText(/no trails yet/i)).not.toBeInTheDocument()
  })

  it('keeps capture working and surfaces a soft error when the trays fetch fails', async () => {
    listCollections.mockRejectedValue(new Error('network down'))
    const onCapture = vi.fn(async () => {})

    render(<TraysScreen cards={[card({ id: 'r1', caption: 'Kyoto' })]} onCapture={onCapture} onOrganize={noop} onCreateTrail={noop} />)

    expect(await screen.findByText(/could not load your trays/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/paste a reel link/i), { target: { value: 'https://ig/reel/z' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(onCapture).toHaveBeenCalledWith('https://ig/reel/z'))
  })

  it('wires CreateTrayDialog to the live collections and creates a tray through the data layer', async () => {
    listCollections.mockResolvedValue([collection({ id: 'c1', name: 'Tokyo winter' })])
    createCollection.mockResolvedValue(collection({ id: 'new-tray', name: 'Kyoto autumn' }))
    addReelsToCollection.mockResolvedValue(undefined)
    const cards = [card({ id: 'r1', caption: 'Kyoto temple' })]

    render(<TraysScreen cards={cards} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: /create a tray/i }))

    const dialog = screen.getByRole('dialog')
    // existingNames is wired from the live collections: the loaded 'Tokyo winter' reads as a dup.
    fireEvent.change(within(dialog).getByLabelText(/tray name/i), { target: { value: 'tokyo winter' } })
    expect(within(dialog).getByText(/already used/i)).toBeInTheDocument()

    // Pick a reel + a fresh name + Create → the data layer runs with the created id and picked ids.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Select Kyoto temple' }))
    fireEvent.change(within(dialog).getByLabelText(/tray name/i), { target: { value: 'Kyoto autumn' } })
    fireEvent.click(within(dialog).getByRole('button', { name: /^create$/i }))

    await waitFor(() => expect(createCollection).toHaveBeenCalledWith('Kyoto autumn'))
    expect(addReelsToCollection).toHaveBeenCalledWith('new-tray', ['r1'])
    // onClose fired on success: the dialog unmounts.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('opens a reel from the Library fan into a ReelInfoCard showing its places', async () => {
    const cards = [card({ id: 'r1', caption: 'Osaka nights', places: [place({ name: 'Dotonbori' })] })]

    render(<TraysScreen cards={cards} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: /your inspiration starts here/i }))
    // Browse is the fan's default mode; the reel renders as a button named by its alt (gsap mocked).
    fireEvent.click(screen.getByRole('button', { name: /osaka nights/i }))

    // The no-op stub is gone: tapping the fan card floats the ReelInfoCard with the reel's places.
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Dotonbori')).toBeInTheDocument()
  })

  it('adds the open reel to a tray through the data layer then re-fetches memberships', async () => {
    listCollections.mockResolvedValue([collection({ id: 'c1', name: 'Tokyo' })])
    getMembershipsByCollection.mockResolvedValue({})
    addReelsToCollection.mockResolvedValue(undefined)
    const cards = [card({ id: 'r1', caption: 'Osaka nights', places: [place({ name: 'Dotonbori' })] })]

    render(<TraysScreen cards={cards} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: /your inspiration starts here/i }))
    fireEvent.click(screen.getByRole('button', { name: /osaka nights/i }))

    // The tray row appears once the live collections load into the open card (traysState ready).
    const trayRow = await screen.findByRole('button', { name: /tokyo/i })
    const fetchesBefore = getMembershipsByCollection.mock.calls.length
    fireEvent.click(trayRow)

    await waitFor(() => expect(addReelsToCollection).toHaveBeenCalledWith('c1', ['r1']))
    // refresh() re-reads memberships so the grid counts stay in sync.
    await waitFor(() => expect(getMembershipsByCollection.mock.calls.length).toBeGreaterThan(fetchesBefore))
    // The row is optimistically marked Added.
    expect(await screen.findByRole('button', { name: /tokyo/i })).toHaveTextContent(/Added/)
  })

  it('closes the Library and opens CreateTrayDialog when New tray… is chosen from a reel (B1)', async () => {
    listCollections.mockResolvedValue([collection({ id: 'c1', name: 'Tokyo' })])
    const cards = [card({ id: 'r1', caption: 'Osaka nights', places: [place({ name: 'Dotonbori' })] })]

    render(<TraysScreen cards={cards} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: /your inspiration starts here/i }))
    fireEvent.click(screen.getByRole('button', { name: /osaka nights/i }))
    await screen.findByRole('dialog') // ReelInfoCard
    fireEvent.click(screen.getByRole('button', { name: /new tray/i }))

    // B1: CreateTrayDialog mounts ONLY in the main return, so New tray… must leave the Library
    // (setLibraryOpen(false)) or the early-return would keep it up and the dialog never appears.
    expect(await screen.findByText(/name a new tray/i)).toBeInTheDocument()
    expect(screen.queryByText(/your saved reels live here/i)).not.toBeInTheDocument()
  })

  it('makes the Library inert while a reel card floats over it (C2)', async () => {
    const cards = [card({ id: 'r1', caption: 'Osaka nights' })]

    render(<TraysScreen cards={cards} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: /your inspiration starts here/i }))
    // Before a card opens the Library is interactive — no inert wrapper.
    expect(screen.getByText(/your saved reels live here/i).closest('[inert]')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /osaka nights/i }))
    await screen.findByRole('dialog')

    // With the card open the Library sits inside an inert wrapper (focus + Back are sealed off).
    expect(screen.getByText(/your saved reels live here/i).closest('[inert]')).not.toBeNull()
  })

  it('resets createPreselect so preselect never leaks into an ordinary New tray open (T2.1c)', async () => {
    listCollections.mockResolvedValue([collection({ id: 'c1', name: 'Tokyo' })])
    const cards = [card({ id: 'r1', caption: 'Osaka nights', places: [place({ name: 'Dotonbori' })] })]

    render(<TraysScreen cards={cards} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)

    // Open Library → open reel r1 → ReelInfoCard.
    fireEvent.click(await screen.findByRole('button', { name: /your inspiration starts here/i }))
    fireEvent.click(screen.getByRole('button', { name: /osaka nights/i }))
    await screen.findByRole('dialog') // ReelInfoCard

    // New tray… from the reel card → CreateTrayDialog opens with r1 preselected.
    fireEvent.click(await screen.findByRole('button', { name: /new tray/i }))
    expect(await screen.findByText(/name a new tray/i)).toBeInTheDocument()
    const preselected = screen.getByRole('dialog')
    expect(within(preselected).getByText('1 selected')).toBeInTheDocument()
    expect(within(preselected).getByRole('button', { name: 'Select Osaka nights', pressed: true })).toBeInTheDocument()

    // Cancel → createPreselect resets to [].
    fireEvent.click(within(preselected).getByRole('button', { name: /^cancel$/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // Ordinary New tray tile → dialog reopens with NOTHING preselected (proves the reset).
    fireEvent.click(screen.getByRole('button', { name: /create a tray/i }))
    const fresh = screen.getByRole('dialog')
    expect(within(fresh).getByText('0 selected')).toBeInTheDocument()
    expect(within(fresh).getByRole('button', { name: 'Select Osaka nights', pressed: false })).toBeInTheDocument()
  })

  it('opens a tray into TrayDetail listing its reels (T3.1a)', async () => {
    listCollections.mockResolvedValue([collection({ id: 'c1', name: 'Tokyo winter' })])
    getMembershipsByCollection.mockResolvedValue({ c1: ['r1'] })
    const cards = [card({ id: 'r1', caption: 'Tokyo Tower' })]

    render(<TraysScreen cards={cards} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Tokyo winter' }))

    // The old no-op stub is gone: Open swaps in TrayDetail listing the tray's member reels.
    expect(await screen.findByRole('heading', { name: 'Tokyo winter' })).toBeInTheDocument()
    expect(screen.getByText('Tokyo Tower')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Tokyo Tower' })).toBeInTheDocument()
  })

  it("forwards the open tray's member cards to onCreateTrail (T3.1a seam)", async () => {
    listCollections.mockResolvedValue([collection({ id: 'c1', name: 'Tokyo winter' })])
    getMembershipsByCollection.mockResolvedValue({ c1: ['r1'] })
    const onCreateTrail = vi.fn()
    const cards = [card({ id: 'r1', caption: 'Tokyo Tower', places: [place({})] })]

    render(<TraysScreen cards={cards} onCapture={noop} onOrganize={noop} onCreateTrail={onCreateTrail} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Tokyo winter' }))
    fireEvent.click(await screen.findByRole('button', { name: /create trail/i }))

    expect(onCreateTrail).toHaveBeenCalledTimes(1)
    expect(onCreateTrail.mock.calls[0][0]).toHaveLength(1)
    expect(onCreateTrail.mock.calls[0][0][0].id).toBe('r1')
  })

  it('deletes a tray, returns to the grid, and re-runs refresh (T3.1a)', async () => {
    listCollections.mockResolvedValue([collection({ id: 'c1', name: 'Tokyo winter' })])
    getMembershipsByCollection.mockResolvedValue({ c1: ['r1'] })
    const cards = [card({ id: 'r1', caption: 'Tokyo Tower' })]

    render(<TraysScreen cards={cards} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Tokyo winter' }))
    await screen.findByRole('heading', { name: 'Tokyo winter' })

    const listCallsBefore = listCollections.mock.calls.length
    listCollections.mockResolvedValue([]) // the tray is gone after the delete
    getMembershipsByCollection.mockResolvedValue({})

    fireEvent.click(screen.getByRole('button', { name: /delete tray/i }))
    fireEvent.click(screen.getByRole('button', { name: /confirm delete/i }))

    await waitFor(() => expect(deleteCollection).toHaveBeenCalledWith('c1'))
    // Back on the grid — the create tile reappears and TrayDetail is gone.
    expect(await screen.findByRole('button', { name: /create a tray/i })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Tokyo winter' })).not.toBeInTheDocument()
    // refresh() re-ran after the delete (best-effort re-sync, Decision 5).
    await waitFor(() => expect(listCollections.mock.calls.length).toBeGreaterThan(listCallsBefore))
  })

  it('renames a tray so the header and grid show the new name (stale-object regression, T3.1a)', async () => {
    listCollections.mockResolvedValue([collection({ id: 'c1', name: 'Old name' })])
    getMembershipsByCollection.mockResolvedValue({})
    renameCollection.mockResolvedValue(collection({ id: 'c1', name: 'New name' }))

    render(<TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Old name' }))
    await screen.findByRole('heading', { name: 'Old name' })

    // The write lands and the server reflects the new name on the next read.
    listCollections.mockResolvedValue([collection({ id: 'c1', name: 'New name' })])

    fireEvent.click(screen.getByRole('button', { name: /^rename$/i }))
    fireEvent.change(screen.getByLabelText(/tray name/i), { target: { value: 'New name' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(renameCollection).toHaveBeenCalledWith('c1', 'New name'))
    // Derived-by-id, not a stored object: the header re-renders with the new name.
    expect(await screen.findByRole('heading', { name: 'New name' })).toBeInTheDocument()

    // Back on the grid, the TrayCard shows the new name too.
    fireEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(await screen.findByRole('button', { name: 'New name' })).toBeInTheDocument()
  })

  it('falls through to the grid when the open tray vanishes (deleted elsewhere), without crashing (Decision 4)', async () => {
    listCollections.mockResolvedValue([collection({ id: 'c1', name: 'Tokyo winter' })])
    getMembershipsByCollection.mockResolvedValue({ c1: ['r1'] })
    const cards = [card({ id: 'r1', caption: 'Tokyo Tower' })]

    render(<TraysScreen cards={cards} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Tokyo winter' }))
    await screen.findByRole('heading', { name: 'Tokyo winter' })

    // The tray was deleted elsewhere: the next refresh (here after a reel remove) returns without it,
    // so the openTrayId-keyed lookup yields undefined.
    listCollections.mockResolvedValue([])
    getMembershipsByCollection.mockResolvedValue({})
    fireEvent.click(screen.getByRole('button', { name: 'Remove Tokyo Tower' }))

    // The `if (openTray)` guard holds: TrayDetail unmounts and the grid renders — no crash.
    expect(await screen.findByRole('button', { name: /create a tray/i })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Tokyo winter' })).not.toBeInTheDocument()
  })

  it('shows a tray reel count from membership even before the cards prop resolves (M3)', async () => {
    listCollections.mockResolvedValue([collection({ id: 'c1', name: 'Tokyo winter' })])
    getMembershipsByCollection.mockResolvedValue({ c1: ['r1', 'r2'] })

    // The cards prop is still empty (the parent's listSavedReelCards hasn't resolved yet). The
    // count must come from membership, not resolved covers — else the tray reads "0 reels".
    render(<TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)

    expect(await screen.findByRole('button', { name: 'Tokyo winter' })).toBeInTheDocument()
    expect(countBadge('2 reels')).toBeInTheDocument()
  })

  it('keeps the renamed name when the post-write refresh READ fails (reconciliation is load-bearing, C-new-2)', async () => {
    listCollections.mockResolvedValue([collection({ id: 'c1', name: 'Old name' })])
    getMembershipsByCollection.mockResolvedValue({})
    renameCollection.mockResolvedValue(collection({ id: 'c1', name: 'New name' }))

    render(<TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Old name' }))
    await screen.findByRole('heading', { name: 'Old name' })

    // Write lands, but the best-effort refresh READ fails (refresh swallows it). Only the local
    // reconciliation keeps the new name; drop it and the stale read resurrects 'Old name'.
    listCollections.mockRejectedValue(new Error('read down'))
    getMembershipsByCollection.mockRejectedValue(new Error('read down'))

    fireEvent.click(screen.getByRole('button', { name: /^rename$/i }))
    fireEvent.change(screen.getByLabelText(/tray name/i), { target: { value: 'New name' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(renameCollection).toHaveBeenCalledWith('c1', 'New name'))
    expect(await screen.findByRole('heading', { name: 'New name' })).toBeInTheDocument()
  })

  it('keeps a removed reel gone when the post-write refresh READ fails (reconciliation is load-bearing, C-new-2)', async () => {
    listCollections.mockResolvedValue([collection({ id: 'c1', name: 'Tokyo winter' })])
    getMembershipsByCollection.mockResolvedValue({ c1: ['r1'] })
    const cards = [card({ id: 'r1', caption: 'Tokyo Tower' })]

    render(<TraysScreen cards={cards} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Tokyo winter' }))
    await screen.findByRole('heading', { name: 'Tokyo winter' })
    expect(screen.getByText('Tokyo Tower')).toBeInTheDocument()

    listCollections.mockRejectedValue(new Error('read down'))
    getMembershipsByCollection.mockRejectedValue(new Error('read down'))

    fireEvent.click(screen.getByRole('button', { name: 'Remove Tokyo Tower' }))

    await waitFor(() => expect(removeReelFromCollection).toHaveBeenCalledWith('c1', 'r1'))
    // Local membership reconciliation dropped r1; the failed refresh cannot resurrect it.
    await waitFor(() => expect(screen.queryByText('Tokyo Tower')).not.toBeInTheDocument())
  })

  it('keeps a deleted tray off the grid when the post-write refresh READ fails (reconciliation is load-bearing, C-new-2)', async () => {
    listCollections.mockResolvedValue([collection({ id: 'c1', name: 'Tokyo winter' })])
    getMembershipsByCollection.mockResolvedValue({ c1: ['r1'] })
    const cards = [card({ id: 'r1', caption: 'Tokyo Tower' })]

    render(<TraysScreen cards={cards} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Tokyo winter' }))
    await screen.findByRole('heading', { name: 'Tokyo winter' })

    listCollections.mockRejectedValue(new Error('read down'))
    getMembershipsByCollection.mockRejectedValue(new Error('read down'))

    fireEvent.click(screen.getByRole('button', { name: /delete tray/i }))
    fireEvent.click(screen.getByRole('button', { name: /confirm delete/i }))

    await waitFor(() => expect(deleteCollection).toHaveBeenCalledWith('c1'))
    // Local reconciliation removed the tray; the failed refresh cannot resurrect it on the grid.
    expect(await screen.findByRole('button', { name: /create a tray/i })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Tokyo winter' })).not.toBeInTheDocument())
  })
})
