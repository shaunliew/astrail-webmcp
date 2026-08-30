import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect } from 'react'

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

import TraysScreen, { starterTripDates } from '@/components/reels/TraysScreen'
import { WebMcpRegistryProvider, useWebMcpRegistry } from '@/components/webmcp/WebMcpRegistry'
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

/* ── Agent-first empty state ───────────────────────────────────────────────────────────────
   Hardcoded here rather than imported from the component, so these are a SPEC and not a
   tautology: the prompt has to stay runnable as written, and `plan_trip_from_reels` will
   refuse it without 1-5 reel URLs AND both dates as YYYY-MM-DD. The dates are read off the
   clock now, so every test that reads a prompt pins the clock to PINNED_NOW and spells out
   the pair it must produce — determinism comes from pinning the clock, not from freezing the
   value in the product. */
const PINNED_NOW = new Date('2026-08-29T00:00:00Z')
const PINNED_START = '2026-09-08' // PINNED_NOW + a ten-day lead
const PINNED_END = '2026-09-13' // + a five-night stay

const STARTER_PROMPT = `Plan me a Tokyo trip from these Instagram Reels:
https://www.instagram.com/reel/DYGH3jFBZHz/
https://www.instagram.com/reel/DYM_I5IvLSv/
https://www.instagram.com/reel/DXwcVVliX3B/
Start date ${PINNED_START}, end date ${PINNED_END}. Mid-range budget, walkable days.`

/* The band's prompt for a home that HAS reels — same date pair, so the two prompts on this
   screen are proved to be built from ONE reading of the clock, not two that can disagree. */
const AGENT_BAND_PROMPT =
  'Look at my saved reels in Astrail and plan me a trip from them. ' +
  `Start date ${PINNED_START}, end date ${PINNED_END}. Mid-range budget, walkable days.`

const INVITATION_HEADING = 'No Reels of your own? Start here.'
const CAPTURE_SUMMARY = 'Prefer to paste Reel links here?'

/** `supported` is set by RegisterTools in the real app; drive it directly here. */
function DeclareSupported({ value }: { value: boolean }) {
  const { setSupported } = useWebMcpRegistry()
  useEffect(() => { setSupported(value) }, [setSupported, value])
  return null
}

function renderWithAgent(ui: React.ReactElement, { supported }: { supported: boolean }) {
  return render(
    <WebMcpRegistryProvider>
      <DeclareSupported value={supported} />
      {ui}
    </WebMcpRegistryProvider>,
  )
}

/** The prompt block, matched on its FULL text — a partial match would not prove it is runnable. */
const starterPromptBlock = () =>
  screen.getByText((_content, el) => el?.tagName === 'PRE' && el.textContent === STARTER_PROMPT)

const captureDetails = () =>
  screen.getByText(CAPTURE_SUMMARY).closest('details') as HTMLDetailsElement

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

    fireEvent.change(screen.getByLabelText(/paste a reel or post link/i), {
      target: { value: 'https://www.instagram.com/reel/AAA/' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(onCapture).toHaveBeenCalledWith('https://www.instagram.com/reel/AAA/'))
  })

  it('renders a captured error message (a mapped Error) in the status banner', async () => {
    // T4: api.ts throws a friendly, already-mapped Error; TraysScreen surfaces its message verbatim
    // in the status banner (pins the user-visible half of the graceful-capture-error change).
    const mappedCopy = "That doesn't look like an Instagram link we can save. Paste a Reel or post URL like instagram.com/reel/… or instagram.com/p/…"
    const onCapture = vi.fn(async () => { throw new Error(mappedCopy) })

    render(<TraysScreen cards={[]} onCapture={onCapture} onOrganize={noop} onCreateTrail={noop} />)

    fireEvent.change(screen.getByLabelText(/paste a reel or post link/i), {
      target: { value: 'https://www.instagram.com/p/DQwdZ8ZCWZx/' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    const banner = await screen.findByRole('status')
    expect(banner).toHaveTextContent(mappedCopy)
  })

  it('adds capture rows with the + button and saves every pasted link', async () => {
    const onCapture = vi.fn(async () => {})

    render(<TraysScreen cards={[]} onCapture={onCapture} onOrganize={noop} onCreateTrail={noop} />)

    fireEvent.click(screen.getByRole('button', { name: /add another link/i }))
    fireEvent.click(screen.getByRole('button', { name: /add another link/i }))

    fireEvent.change(screen.getByLabelText('Paste a Reel or post link'), {
      target: { value: 'https://www.instagram.com/reel/AAA/' },
    })
    fireEvent.change(screen.getByLabelText('Paste a Reel or post link 2'), {
      target: { value: 'https://www.instagram.com/reel/BBB/' },
    })
    fireEvent.change(screen.getByLabelText('Paste a Reel or post link 3'), {
      target: { value: 'https://www.instagram.com/p/CCC/' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(onCapture).toHaveBeenCalledTimes(3))
    expect(onCapture).toHaveBeenNthCalledWith(1, 'https://www.instagram.com/reel/AAA/')
    expect(onCapture).toHaveBeenNthCalledWith(2, 'https://www.instagram.com/reel/BBB/')
    expect(onCapture).toHaveBeenNthCalledWith(3, 'https://www.instagram.com/p/CCC/')
    expect(await screen.findByText(/saved 3 links to your library/i)).toBeInTheDocument()
    // Saved rows collapse back to the single empty input.
    expect(screen.queryByLabelText('Paste a Reel or post link 2')).not.toBeInTheDocument()
  })

  it('caps capture rows at 5 and swaps the + button for the max hint', async () => {
    render(<TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)

    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByRole('button', { name: /add another link/i }))
    }

    expect(screen.getByLabelText('Paste a Reel or post link 5')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add another link/i })).not.toBeInTheDocument()
    expect(screen.getByText(/max 5 links at a time/i)).toBeInTheDocument()

    // A row can be removed again, which brings the + button back.
    fireEvent.click(screen.getByRole('button', { name: 'Remove link 5' }))
    expect(screen.queryByLabelText('Paste a Reel or post link 5')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add another link/i })).toBeInTheDocument()
  })

  it('keeps the failed link in its row and reports a partial save', async () => {
    const failCopy = "That doesn't look like an Instagram link we can save."
    const onCapture = vi.fn(async (url: string) => {
      if (url.includes('bad')) throw new Error(failCopy)
    })

    render(<TraysScreen cards={[]} onCapture={onCapture} onOrganize={noop} onCreateTrail={noop} />)

    fireEvent.click(screen.getByRole('button', { name: /add another link/i }))
    fireEvent.change(screen.getByLabelText('Paste a Reel or post link'), {
      target: { value: 'https://www.instagram.com/reel/GOOD/' },
    })
    fireEvent.change(screen.getByLabelText('Paste a Reel or post link 2'), {
      target: { value: 'https://www.instagram.com/bad' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

    const banner = await screen.findByRole('status')
    expect(banner).toHaveTextContent('Saved 1 of 2 links.')
    expect(banner).toHaveTextContent(failCopy)
    // The failed link survives (now in the first row) so it can be fixed and retried.
    expect(screen.getByLabelText('Paste a Reel or post link')).toHaveValue('https://www.instagram.com/bad')
    expect(screen.queryByLabelText('Paste a Reel or post link 2')).not.toBeInTheDocument()
  })

  it('shows the empty state when there are no reels and no trays', async () => {
    render(<TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)

    expect(await screen.findByText(/no trays yet/i)).toBeInTheDocument()
  })

  it('names the same thing in the empty state as in the section header', async () => {
    /* It said "No trails yet" above a section headed "Your trays" — two different nouns for two
       different things, describing an absence the user was not looking at. A trail is the TRIP you
       generate from a tray; what is missing on an empty screen is trays. */
    render(<TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)
    await screen.findByText(/no trays yet/i)
    expect(screen.queryByText(/no trails yet/i)).toBeNull()
  })

  it('defines "tray" where the word is first used', async () => {
    // Neither "tray" nor "trail" is self-evident, and neither was defined anywhere. The empty
    // state is the one screen with room to say it, and the first place anyone meets the word.
    render(<TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)
    expect(await screen.findByText(/a tray is a group of saved reels/i)).toBeInTheDocument()
  })

  it('shows the error banner (not the empty state) when the trays fetch fails with no reels', async () => {
    listCollections.mockRejectedValue(new Error('network down'))

    render(<TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />)

    // A transient listCollections failure must surface the error, not the misleading empty state.
    expect(await screen.findByText(/could not load your trays/i)).toBeInTheDocument()
    expect(screen.queryByText(/no trays yet/i)).not.toBeInTheDocument()
  })

  it('keeps capture working and surfaces a soft error when the trays fetch fails', async () => {
    listCollections.mockRejectedValue(new Error('network down'))
    const onCapture = vi.fn(async () => {})

    render(<TraysScreen cards={[card({ id: 'r1', caption: 'Kyoto' })]} onCapture={onCapture} onOrganize={noop} onCreateTrail={noop} />)

    expect(await screen.findByText(/could not load your trays/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/paste a reel or post link/i), { target: { value: 'https://ig/reel/z' } })
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

  /* The starter prompt's dates come off the clock instead of being frozen in the source. A
     frozen pair rots two ways: a judge reading it months on sees a trip suspiciously far out,
     and a judge reading it a year on sees one in the PAST, which `plan_trip_from_reels` will
     happily accept and plan. It also has to land inside the forecast window — a real run on
     2026-08-28 for dates 14 days out already came back "No forecast available this far ahead". */
  describe('starterTripDates', () => {
    /** Runs `fn` under a fixed zone, so "is this built in UTC?" is an answerable question. */
    function withTz<T>(tz: string, fn: () => T): T {
      const previous = process.env.TZ
      process.env.TZ = tz
      try {
        return fn()
      } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, 'TZ')
        else process.env.TZ = previous
      }
    }

    it('lands the trip ten days out and runs it for five nights', () => {
      expect(starterTripDates(PINNED_NOW)).toEqual({ start: PINNED_START, end: PINNED_END })
    })

    it('reads the calendar day in UTC, not local time, a minute before local midnight in GMT+8', () => {
      // The trap this guards: taking LOCAL date parts and serialising them back through
      // toISOString(). In Asia/Kuala_Lumpur — Zhi Hao's zone, and most of our judges' — this
      // instant is 23:59 on the 29th locally; a locally-built midnight serialises to the
      // PREVIOUS UTC day, quietly shipping a nine-day lead and a prompt that disagrees with
      // the same page loaded an hour later.
      expect(withTz('Asia/Kuala_Lumpur', () => starterTripDates(new Date('2026-08-29T15:59:00Z')))).toEqual({
        start: '2026-09-08',
        end: '2026-09-13',
      })
    })

    it('reads the calendar day in UTC, not local time, just after UTC midnight west of Greenwich', () => {
      // Same trap from the other side: in America/New_York this instant is still 31 August
      // locally, so anything anchored on local parts lands the trip a day early.
      expect(withTz('America/New_York', () => starterTripDates(new Date('2026-09-01T00:30:00Z')))).toEqual({
        start: '2026-09-11',
        end: '2026-09-16',
      })
    })

    it('crosses a month end and a year end without drifting', () => {
      expect(starterTripDates(new Date('2026-12-27T00:00:00Z'))).toEqual({
        start: '2027-01-06',
        end: '2027-01-11',
      })
    })

    it('emits the well-formed, forward-ordered pair plan_trip_from_reels demands, at every clock', () => {
      // A malformed or reversed pair is a rejected tool call, not a cosmetic slip — so walk a
      // year of clocks rather than trusting one sample. Run it in a zone WITH daylight saving:
      // day arithmetic done with local setDate() loses or gains an hour across a transition,
      // which is exactly how a "10 days out" window silently becomes nine.
      withTz('America/New_York', () => {
        const isoDay = /^\d{4}-\d{2}-\d{2}$/
        for (let offset = 0; offset < 400; offset += 1) {
          const now = new Date(Date.UTC(2026, 0, 1) + offset * 86_400_000)
          const { start, end } = starterTripDates(now)
          expect(start).toMatch(isoDay)
          expect(end).toMatch(isoDay)
          expect(end > start).toBe(true)
          expect((Date.parse(start) - now.getTime()) / 86_400_000).toBe(10)
        }
      })
    })
  })

  /* An empty /app was a paste-a-URL form and nothing else — a dead end for anyone who arrives
     without Instagram links in hand. Verified live in ChatGPT's browser on an empty account:
     asked "what can I do here?", the agent answered "start by pasting up to five Reel links",
     and a reviewer proved it read that off the RENDERED PAGE (it also listed "Trails / New
     trail / Settings", strings that exist only in Sidebar.tsx). The layout is the prompt. */
  describe('agent-first empty state', () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

    beforeEach(() => {
      // Only Date is faked: setTimeout stays real so waitFor/findBy still resolve normally.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(PINNED_NOW)
    })

    afterEach(() => {
      vi.useRealTimers()
      if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
      else Reflect.deleteProperty(navigator as object, 'clipboard')
    })

    function stubClipboard(writeText: () => Promise<void>) {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    }

    it('gives the primary position to a runnable agent prompt when WebMCP is supported', async () => {
      renderWithAgent(
        <TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />,
        { supported: true },
      )

      expect(await screen.findByText(INVITATION_HEADING)).toBeInTheDocument()
      // Runnable AS WRITTEN — the three URLs and both ISO dates, verbatim, in one block.
      expect(starterPromptBlock()).toBeInTheDocument()
      // A wiped account can have zero reels AND an exhausted trip entitlement; they are
      // unrelated, so the invitation must promise nothing about what the user may spend.
      expect(screen.queryByText(/allowance|free trip|credit/i)).toBeNull()
    })

    it('prints dates read off the clock, not a pair frozen into the source', async () => {
      renderWithAgent(
        <TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />,
        { supported: true },
      )

      await screen.findByText(INVITATION_HEADING)
      const block = screen.getByText(
        (_content, el) => el?.tagName === 'PRE' && el.textContent?.startsWith('Plan me a Tokyo trip') === true,
      )
      // The clock is pinned to PINNED_NOW for this describe, so the rendered dates must follow it.
      expect(block.textContent).toContain(`Start date ${PINNED_START}, end date ${PINNED_END}.`)
      // The pair the screen shipped with: near enough at the time, 77 days out by the day this
      // was found, and past by next year. Nothing may print a date the clock did not produce.
      expect(block.textContent).not.toContain('2026-11-14')
      expect(block.textContent).not.toContain('2026-11-19')
    })

    it('demotes the capture form into a closed details instead of deleting it', async () => {
      renderWithAgent(
        <TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />,
        { supported: true },
      )

      await screen.findByText(INVITATION_HEADING)
      expect(captureDetails().open).toBe(false)
      expect(screen.getByLabelText(/paste a reel or post link/i)).not.toBeVisible()
    })

    it('keeps the manual-first layout unchanged in a browser with no agent', async () => {
      // A judge in Safari must never see an agent prompt with the manual form hidden.
      renderWithAgent(
        <TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />,
        { supported: false },
      )

      expect(await screen.findByText(/no trays yet/i)).toBeInTheDocument()
      expect(screen.queryByText(INVITATION_HEADING)).toBeNull()
      expect(screen.queryByText(CAPTURE_SUMMARY)).toBeNull()
      expect(screen.getByLabelText(/paste a reel or post link/i)).toBeVisible()
    })

    it('will not call an account empty while its saved reels are still loading', async () => {
      // A confident zero on data we have not read is the defect this codebase keeps finding.
      renderWithAgent(
        <TraysScreen cards={[]} cardsStatus="loading" onCapture={noop} onOrganize={noop} onCreateTrail={noop} />,
        { supported: true },
      )

      // Wait for the collections read to land, so this is not just "the effect has not run yet".
      await waitFor(() => expect(listCollections).toHaveBeenCalled())
      expect(screen.queryByText(INVITATION_HEADING)).toBeNull()
      expect(screen.getByLabelText(/paste a reel or post link/i)).toBeVisible()
    })

    it('will not call an account empty when the saved-reel fetch failed', async () => {
      renderWithAgent(
        <TraysScreen cards={[]} cardsStatus="error" onCapture={noop} onOrganize={noop} onCreateTrail={noop} />,
        { supported: true },
      )

      await waitFor(() => expect(listCollections).toHaveBeenCalled())
      expect(screen.queryByText(INVITATION_HEADING)).toBeNull()
      expect(screen.getByLabelText(/paste a reel or post link/i)).toBeVisible()
    })

    it('shows the trays error, not the agent prompt, when the collections read fails', async () => {
      listCollections.mockRejectedValue(new Error('network down'))

      renderWithAgent(
        <TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />,
        { supported: true },
      )

      expect(await screen.findByText(/could not load your trays/i)).toBeInTheDocument()
      expect(screen.queryByText(INVITATION_HEADING)).toBeNull()
      expect(screen.getByLabelText(/paste a reel or post link/i)).toBeVisible()
    })

    it('opens the demoted capture form from its summary', async () => {
      renderWithAgent(
        <TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />,
        { supported: true },
      )

      fireEvent.click(await screen.findByText(CAPTURE_SUMMARY))

      expect(captureDetails().open).toBe(true)
      expect(screen.getByLabelText(/paste a reel or post link/i)).toBeVisible()
    })

    it('still captures a Reel URL through the demoted form once it is open', async () => {
      const onCapture = vi.fn(async () => {})
      renderWithAgent(
        <TraysScreen cards={[]} onCapture={onCapture} onOrganize={noop} onCreateTrail={noop} />,
        { supported: true },
      )

      fireEvent.click(await screen.findByText(CAPTURE_SUMMARY))
      fireEvent.change(screen.getByLabelText(/paste a reel or post link/i), {
        target: { value: 'https://www.instagram.com/reel/AAA/' },
      })
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }))

      await waitFor(() => expect(onCapture).toHaveBeenCalledWith('https://www.instagram.com/reel/AAA/'))
      expect(await screen.findByText('Saved to your library.')).toBeInTheDocument()
    })

    it('copies the prompt verbatim', async () => {
      const writeText = vi.fn(async () => {})
      stubClipboard(writeText)
      renderWithAgent(
        <TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />,
        { supported: true },
      )

      fireEvent.click(await screen.findByRole('button', { name: /copy prompt/i }))

      await waitFor(() => expect(writeText).toHaveBeenCalledWith(STARTER_PROMPT))
      expect(await screen.findByText(/copied\./i)).toBeInTheDocument()
    })

    it('falls back to the selectable text when the clipboard refuses', async () => {
      // Clipboard access is permission-gated and absent over plain http; the prompt is rendered
      // as selectable text for exactly this case, so the fallback has to name it.
      stubClipboard(vi.fn(async () => { throw new Error('denied') }))
      renderWithAgent(
        <TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />,
        { supported: true },
      )

      fireEvent.click(await screen.findByRole('button', { name: /copy prompt/i }))

      expect(await screen.findByText(/select the prompt above/i)).toBeInTheDocument()
      expect(starterPromptBlock()).toBeInTheDocument()
    })

    it('does not put the agent prompt in front of an account that already has reels', async () => {
      renderWithAgent(
        <TraysScreen cards={[card({ id: 'r1' })]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />,
        { supported: true },
      )

      expect(await screen.findByText(/your inspiration starts here/i)).toBeInTheDocument()
      expect(screen.queryByText(INVITATION_HEADING)).toBeNull()
      expect(screen.queryByText(CAPTURE_SUMMARY)).toBeNull()
    })

    it('promises approval for the step that is actually gated, not for everything', async () => {
      /* "before anything runs" was an absolute this flow does not honour. An agent handed the
         starter prompt may call `save_reels` on its way to planning, and that tool raises NO
         approval card while starting a paid extraction — it argues the case in its own
         description (daily limit, never re-analyses). What IS gated is the generation:
         `plan_trip_from_reels` awaits confirm() before it creates the trip. So the sentence
         names that step and claims nothing wider.

         It still says nothing about spend, for the reason the test above pins: this screen is
         shown to accounts whose trip entitlement may already be gone. */
      renderWithAgent(
        <TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />,
        { supported: true },
      )

      await screen.findByText(INVITATION_HEADING)
      expect(
        screen.getByText(
          'Astrail will ask you to approve the plan on this page before it starts building the trip.',
        ),
      ).toBeInTheDocument()
      expect(screen.queryByText(/before anything runs/i)).toBeNull()
    })
  })

  /* The same finding, one screen later. `/app` WITH content was a manual library with the agent
     in a dismissible corner dock, so the loudest thing on the page was still a paste box and a
     24px "Your inspiration starts here". Whatever the screen says loudest is what the agent says
     back. The band takes the top; the library keeps everything it had, at row rank. */
  describe('agent band on a home that has content', () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

    beforeEach(() => {
      // Only Date is faked: setTimeout stays real so waitFor/findBy still resolve normally.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(PINNED_NOW)
    })

    afterEach(() => {
      vi.useRealTimers()
      if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
      else Reflect.deleteProperty(navigator as object, 'clipboard')
    })

    const band = () => screen.getByRole('region', { name: 'Astrail agent' })

    it('puts the band above the greeting and the library, counted against the library', async () => {
      renderWithAgent(
        <TraysScreen
          cards={[card({ id: 'r1' }), card({ id: 'r2' })]}
          onCapture={noop} onOrganize={noop} onCreateTrail={noop}
        />,
        { supported: true },
      )

      const library = await screen.findByRole('button', { name: /your inspiration starts here/i })
      const greeting = screen.getByText(/welcome back/i)

      expect(
        screen.getByText(
          'With this page open, ChatGPT can read your 2 saved reels, save new links, and plan a trip from them — planning spends your trip allowance, so it asks for your approval here first.',
        ),
      ).toBeInTheDocument()

      // First thing read, not merely present: the agent reads the page top-down.
      expect(band().compareDocumentPosition(greeting) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(band().compareDocumentPosition(library) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('hands the band the same clock-derived dates the starter prompt states', async () => {
      /* The band's prompt is the OTHER consumer of the demo date pair, and the one a user with
         reels actually copies. It has to carry the derived window too — a band left on a frozen
         pair would ask `plan_trip_from_reels` for a trip past the forecast horizon, or, read a
         year on, for one in the past. Matched on FULL text: a partial match would not prove the
         prompt runs as written. */
      renderWithAgent(
        <TraysScreen cards={[card({ id: 'r1' })]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />,
        { supported: true },
      )

      expect(
        await screen.findByText(
          (_content, el) => el?.tagName === 'PRE' && el.textContent === AGENT_BAND_PROMPT,
        ),
      ).toBeInTheDocument()
    })

    it('does not claim a count the parent has not finished reading', async () => {
      // cards=[] with an in-flight saved-reel fetch is indistinguishable from an empty library
      // by length alone, so the band must not print a number it cannot stand behind.
      listCollections.mockResolvedValue([collection({ id: 'c1', name: 'Tokyo winter' })])

      renderWithAgent(
        <TraysScreen cards={[]} cardsStatus="loading" onCapture={noop} onOrganize={noop} onCreateTrail={noop} />,
        { supported: true },
      )

      await screen.findByRole('button', { name: 'Tokyo winter' })
      expect(
        screen.getByText(
          'With this page open, ChatGPT can read your saved reels, save new links, and plan a trip from them — planning spends your trip allowance, so it asks for your approval here first.',
        ),
      ).toBeInTheDocument()
    })

    it('does not flash the band on an empty account while the trays read is still open', async () => {
      /* Regression. Painted on "supported and not the empty-state invitation", the band appears
         on the FIRST frame of an empty account — `loading` is still true there, so
         `confirmedEmpty` is not true YET — and the invitation then replaces it. Besides the
         flicker in the one position that must not move, the button is detached for that window:
         a click in it is silently swallowed, which is exactly how the copy-prompt tests failed. */
      listCollections.mockReturnValue(new Promise(() => {})) // never settles: hold the first frame

      renderWithAgent(
        <TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />,
        { supported: true },
      )

      expect(screen.queryByRole('region', { name: 'Astrail agent' })).toBeNull()
      expect(screen.queryByRole('button', { name: /copy prompt/i })).toBeNull()
    })

    it('paints the band immediately when reels are already in hand, without waiting on trays', () => {
      // The wait above is only owed by an account that LOOKS empty. Reels in hand already say
      // this is a home with content, so the top of the page must not sit blank behind a fetch.
      listCollections.mockReturnValue(new Promise(() => {}))

      renderWithAgent(
        <TraysScreen cards={[card({ id: 'r1' })]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />,
        { supported: true },
      )

      expect(screen.getByRole('region', { name: 'Astrail agent' })).toBeInTheDocument()
    })

    it('shows no agent copy in a browser with no agent, and leaves the library route intact', async () => {
      renderWithAgent(
        <TraysScreen cards={[card({ id: 'r1' })]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />,
        { supported: false },
      )

      expect(await screen.findByRole('button', { name: /your inspiration starts here/i })).toBeInTheDocument()
      expect(screen.queryByRole('region', { name: 'Astrail agent' })).toBeNull()
      expect(screen.queryByText(/chatgpt/i)).toBeNull()
      expect(screen.getByLabelText(/paste a reel or post link/i)).toBeVisible()
    })

    it('never stacks the band on top of the empty-account invitation', async () => {
      // Two agent blocks with two "Copy prompt" buttons and two different prompts is worse than
      // either alone; the invitation already owns the empty case.
      renderWithAgent(
        <TraysScreen cards={[]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />,
        { supported: true },
      )

      expect(await screen.findByText(INVITATION_HEADING)).toBeInTheDocument()
      expect(screen.queryByRole('region', { name: 'Astrail agent' })).toBeNull()
      expect(screen.getAllByRole('button', { name: /copy prompt/i })).toHaveLength(1)
    })

    it('demotes the library from a hero banner to a row header above the trays', async () => {
      // jsdom has no layout, so rank is asserted through the type tokens: the library entry has
      // to read at the SAME rank as the section header under it, not a size above it, and it
      // must no longer carry the brass hero box that made it the loudest block on the page.
      renderWithAgent(
        <TraysScreen cards={[card({ id: 'r1' })]} onCapture={noop} onOrganize={noop} onCreateTrail={noop} />,
        { supported: true },
      )

      const library = await screen.findByRole('button', { name: /your inspiration starts here/i })
      const title = within(library).getByText('Your inspiration starts here')

      expect(title.className).toContain('text-[18px]')
      expect(screen.getByRole('heading', { name: 'Your trays' }).className).toContain('text-[18px]')
      expect(library.className).not.toContain('brass-wash')
      // …and the band that replaced it is a band, not a new hero in the same spot.
      expect(band().className).not.toContain('brass-wash')
    })
  })
})
