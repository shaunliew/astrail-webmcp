import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { createCollection, addReelsToCollection } = vi.hoisted(() => ({
  createCollection: vi.fn(),
  addReelsToCollection: vi.fn(),
}))

vi.mock('@/lib/reels/collections', () => ({ createCollection, addReelsToCollection }))

import CreateTrayDialog from '@/components/reels/CreateTrayDialog'
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

const noop = async () => {}
const nameField = () => screen.getByLabelText(/tray name/i)
const createBtn = () => screen.getByRole('button', { name: /^create$/i })

describe('CreateTrayDialog', () => {
  afterEach(() => {
    cleanup()
    createCollection.mockReset()
    addReelsToCollection.mockReset()
  })

  it('creates the tray then attaches exactly the picked reel ids', async () => {
    createCollection.mockResolvedValue(collection({ id: 'new-tray', name: 'Tokyo winter' }))
    addReelsToCollection.mockResolvedValue(undefined)
    const onCreated = vi.fn(async () => {})
    const onClose = vi.fn()
    const cards = [
      card({ id: 'r1', caption: 'Tokyo Tower' }),
      card({ id: 'r2', caption: 'Shibuya' }),
      card({ id: 'r3', caption: 'Kyoto' }),
    ]

    render(<CreateTrayDialog cards={cards} existingNames={[]} onCreated={onCreated} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Select Tokyo Tower' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select Kyoto' }))
    fireEvent.change(nameField(), { target: { value: 'Tokyo winter' } })
    fireEvent.click(createBtn())

    await waitFor(() => expect(createCollection).toHaveBeenCalledWith('Tokyo winter'))
    expect(addReelsToCollection).toHaveBeenCalledWith('new-tray', ['r1', 'r3'])
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onCreated).toHaveBeenCalled()
  })

  it('disables Create for an empty or whitespace-only name', () => {
    render(<CreateTrayDialog cards={[]} existingNames={[]} onCreated={noop} onClose={vi.fn()} />)

    expect(createBtn()).toBeDisabled()

    fireEvent.change(nameField(), { target: { value: '   ' } })
    expect(createBtn()).toBeDisabled()

    fireEvent.change(nameField(), { target: { value: 'Bali' } })
    expect(createBtn()).not.toBeDisabled()
  })

  it('disables Create for a case-insensitive duplicate name and shows a hint', () => {
    render(<CreateTrayDialog cards={[]} existingNames={['Japan']} onCreated={noop} onClose={vi.fn()} />)

    fireEvent.change(nameField(), { target: { value: 'japan' } })
    expect(createBtn()).toBeDisabled()
    expect(screen.getByText(/already used/i)).toBeInTheDocument()

    fireEvent.change(nameField(), { target: { value: ' JAPAN ' } })
    expect(createBtn()).toBeDisabled()

    fireEvent.change(nameField(), { target: { value: 'Korea' } })
    expect(createBtn()).not.toBeDisabled()
    expect(screen.queryByText(/already used/i)).not.toBeInTheDocument()
  })

  it('narrows the reel picker by a country filter chip', () => {
    const jp = card({ id: 'jp', caption: 'Tokyo Tower', places: [place({ country_code: 'JP', country_name: 'Japan', name: 'Tokyo Tower' })] })
    const kr = card({ id: 'kr', caption: 'Myeongdong', places: [place({ country_code: 'KR', country_name: 'South Korea', name: 'Myeongdong' })] })

    render(<CreateTrayDialog cards={[jp, kr]} existingNames={[]} onCreated={noop} onClose={vi.fn()} />)

    expect(screen.getByText('Tokyo Tower')).toBeInTheDocument()
    expect(screen.getByText('Myeongdong')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Japan' }))

    expect(screen.getByText('Tokyo Tower')).toBeInTheDocument()
    expect(screen.queryByText('Myeongdong')).not.toBeInTheDocument()
  })

  it('creates an empty tray without touching addReelsToCollection', async () => {
    createCollection.mockResolvedValue(collection({ id: 'empty-tray', name: 'Someday' }))
    const onCreated = vi.fn(async () => {})
    const onClose = vi.fn()

    render(<CreateTrayDialog cards={[card({ id: 'r1', caption: 'Tokyo' })]} existingNames={[]} onCreated={onCreated} onClose={onClose} />)

    fireEvent.change(nameField(), { target: { value: 'Someday' } })
    fireEvent.click(createBtn())

    await waitFor(() => expect(createCollection).toHaveBeenCalledWith('Someday'))
    expect(addReelsToCollection).not.toHaveBeenCalled()
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onCreated).toHaveBeenCalled()
  })

  it('keeps the created tray on a partial failure and retries attachment with the same id (create once)', async () => {
    createCollection.mockResolvedValue(collection({ id: 'kept-tray', name: 'Osaka' }))
    addReelsToCollection.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(undefined)
    const onCreated = vi.fn(async () => {})
    const onClose = vi.fn()

    render(<CreateTrayDialog cards={[card({ id: 'r1', caption: 'Dotonbori' })]} existingNames={[]} onCreated={onCreated} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Select Dotonbori' }))
    fireEvent.change(nameField(), { target: { value: 'Osaka' } })
    fireEvent.click(createBtn())

    // Partial failure: the tray was created, the reels were not attached.
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't add your reels/i)
    // Grid still refreshed so the new (empty) tray appears, but the dialog stays open.
    expect(onCreated).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()

    // Retry re-attaches to the SAME created id without creating a second tray.
    fireEvent.click(screen.getByRole('button', { name: /^retry$/i }))

    await waitFor(() => expect(addReelsToCollection).toHaveBeenCalledTimes(2))
    expect(createCollection).toHaveBeenCalledTimes(1)
    expect(addReelsToCollection).toHaveBeenNthCalledWith(1, 'kept-tray', ['r1'])
    expect(addReelsToCollection).toHaveBeenNthCalledWith(2, 'kept-tray', ['r1'])
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('maps a concurrent unique-name collision to the already-used message', async () => {
    createCollection.mockRejectedValue(new Error('A tray named "Osaka" already exists.'))
    const onClose = vi.fn()

    render(<CreateTrayDialog cards={[]} existingNames={[]} onCreated={noop} onClose={onClose} />)

    fireEvent.change(nameField(), { target: { value: 'Osaka' } })
    fireEvent.click(createBtn())

    expect(await screen.findByRole('alert')).toHaveTextContent(/already used/i)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('skips the catch body when createCollection rejects after unmount (unmount guard)', async () => {
    let rejectCreate!: (err: unknown) => void
    createCollection.mockImplementation(() => new Promise((_, reject) => { rejectCreate = reject }))
    const err = new Error()
    let messageReads = 0
    Object.defineProperty(err, 'message', { configurable: true, get() { messageReads++; return 'boom' } })

    const { unmount } = render(
      <CreateTrayDialog cards={[]} existingNames={[]} onCreated={noop} onClose={vi.fn()} />,
    )

    fireEvent.change(nameField(), { target: { value: 'Kyoto' } })
    fireEvent.click(createBtn())

    await waitFor(() => expect(createCollection).toHaveBeenCalledTimes(1))

    unmount()

    await act(async () => {
      rejectCreate(err)
      await Promise.resolve()
    })

    // The activeRef guard returned before the catch inspected the rejection.
    expect(messageReads).toBe(0)
  })

  // Execution-based unmount guards for the three async-setState branches other than the
  // outer-catch (covered above). Each proves the activeRef guard is load-bearing by observing
  // that the post-await work — a state-derived read or a parent callback — never runs after
  // unmount; without the guard React 19 would silently drop the setState (no console warning).

  it('skips setCreatedId when createCollection resolves after unmount (create-success guard)', async () => {
    let resolveCreate!: (v: unknown) => void
    createCollection.mockImplementation(() => new Promise((resolve) => { resolveCreate = resolve }))
    const row = collection({ name: 'Kyoto' })
    let idReads = 0
    Object.defineProperty(row, 'id', { configurable: true, get() { idReads++; return 'kept' } })

    const { unmount } = render(
      <CreateTrayDialog cards={[]} existingNames={[]} onCreated={noop} onClose={vi.fn()} />,
    )
    fireEvent.change(nameField(), { target: { value: 'Kyoto' } })
    fireEvent.click(createBtn())

    await waitFor(() => expect(createCollection).toHaveBeenCalledTimes(1))
    unmount()

    await act(async () => {
      resolveCreate(row)
      await Promise.resolve()
    })

    // The guard returned before `collectionId = created.id` / setCreatedId ran.
    expect(idReads).toBe(0)
  })

  it('skips the grid refresh when the attach rejects after unmount (attach-fail guard)', async () => {
    createCollection.mockResolvedValue(collection({ id: 'kept', name: 'Osaka' }))
    let rejectAttach!: (err: unknown) => void
    addReelsToCollection.mockImplementation(() => new Promise((_, reject) => { rejectAttach = reject }))
    const onCreated = vi.fn(async () => {})

    const { unmount } = render(
      <CreateTrayDialog cards={[card({ id: 'r1', caption: 'Dotonbori' })]} existingNames={[]} onCreated={onCreated} onClose={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Select Dotonbori' }))
    fireEvent.change(nameField(), { target: { value: 'Osaka' } })
    fireEvent.click(createBtn())

    await waitFor(() => expect(addReelsToCollection).toHaveBeenCalledTimes(1))
    unmount()

    await act(async () => {
      rejectAttach(new Error('network'))
      await Promise.resolve()
    })

    // The inner catch's guard returned before onCreated()/setError ran.
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('skips onClose when onCreated resolves after unmount (full-success guard)', async () => {
    createCollection.mockResolvedValue(collection({ id: 'done', name: 'Nara' }))
    let resolveCreated!: () => void
    const onCreated = vi.fn(() => new Promise<void>((resolve) => { resolveCreated = resolve }))
    const onClose = vi.fn()

    const { unmount } = render(
      <CreateTrayDialog cards={[]} existingNames={[]} onCreated={onCreated} onClose={onClose} />,
    )
    fireEvent.change(nameField(), { target: { value: 'Nara' } })
    fireEvent.click(createBtn())

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    unmount()

    await act(async () => {
      resolveCreated()
      await Promise.resolve()
    })

    // The post-onCreated guard returned before onClose() ran.
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape and via Cancel', () => {
    const onClose = vi.fn()
    const { rerender } = render(<CreateTrayDialog cards={[]} existingNames={[]} onCreated={noop} onClose={onClose} />)

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    rerender(<CreateTrayDialog cards={[]} existingNames={[]} onCreated={noop} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('disables the name input once the tray exists (partial-failure retry state)', async () => {
    createCollection.mockResolvedValue(collection({ id: 'kept-tray', name: 'Osaka' }))
    addReelsToCollection.mockRejectedValueOnce(new Error('network'))

    render(<CreateTrayDialog cards={[card({ id: 'r1', caption: 'Dotonbori' })]} existingNames={[]} onCreated={noop} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Select Dotonbori' }))
    fireEvent.change(nameField(), { target: { value: 'Osaka' } })
    expect(nameField()).not.toBeDisabled()
    fireEvent.click(createBtn())

    // Partial failure → Retry state: the name is now fixed on the server, so the field locks.
    expect(await screen.findByRole('button', { name: /^retry$/i })).toBeInTheDocument()
    expect(nameField()).toBeDisabled()
  })

  it('does not mislabel a non-duplicate error that merely contains "unique"', async () => {
    createCollection.mockRejectedValue(new Error('connection reset on a unique constraint check timeout'))
    const onClose = vi.fn()

    render(<CreateTrayDialog cards={[]} existingNames={[]} onCreated={noop} onClose={onClose} />)

    fireEvent.change(nameField(), { target: { value: 'Sapporo' } })
    fireEvent.click(createBtn())

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/unique/i)
    expect(screen.queryByText(/already used/i)).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('still flags a raw 23505 PostgrestError as a duplicate name via the code branch', async () => {
    createCollection.mockRejectedValue({ code: '23505', message: 'duplicate key value violates unique constraint' })
    const onClose = vi.fn()

    render(<CreateTrayDialog cards={[]} existingNames={[]} onCreated={noop} onClose={onClose} />)

    fireEvent.change(nameField(), { target: { value: 'Nara' } })
    fireEvent.click(createBtn())

    expect(await screen.findByRole('alert')).toHaveTextContent(/already used/i)
    expect(onClose).not.toHaveBeenCalled()
  })
})
