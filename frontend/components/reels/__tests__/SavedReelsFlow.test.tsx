import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { pickTripDates } from '@/test/pickTripDates'
import { WebMcpRegistryProvider, useWebMcpRegistry } from '@/components/webmcp/WebMcpRegistry'

const { push, getAccessToken, listSavedReelCards, startOrganize, streamOrganize, getOrganizeStatus, generateTrip, streamGeneration, useEntitlement, requestSeat, mapInstance } = vi.hoisted(() => ({
  push: vi.fn(),
  getAccessToken: vi.fn(async () => 'token'),
  listSavedReelCards: vi.fn(),
  startOrganize: vi.fn(),
  streamOrganize: vi.fn(),
  getOrganizeStatus: vi.fn(),
  generateTrip: vi.fn(async (_req: { place_ids: string[]; reel_urls: string[]; requested_places: unknown[] }, _token: string) => ({ trip_id: 'trip-1' })),
  streamGeneration: vi.fn(),
  useEntitlement: vi.fn(),
  requestSeat: vi.fn(async () => {}),
  mapInstance: (() => {
    const handler = () => ({ enable: vi.fn(), disable: vi.fn() })
    return {
      on: vi.fn(), setConfigProperty: vi.fn(), fitBounds: vi.fn(),
      remove: vi.fn(), resize: vi.fn(), stop: vi.fn(),
      style: { setTransition: vi.fn() },
      scrollZoom: handler(), boxZoom: handler(), dragRotate: handler(), dragPan: handler(),
      keyboard: handler(), doubleClickZoom: handler(), touchZoomRotate: handler(), touchPitch: handler(),
    }
  })(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('next/link', () => ({ default: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a> }))
vi.mock('@/lib/supabase/session', () => ({ getAccessToken }))
vi.mock('@/lib/reels/api', () => ({ listSavedReelCards, startOrganize, streamOrganize, getOrganizeStatus }))
// Keep the real ApiError (classifyGenerateError branches on `instanceof ApiError`); override
// only the two network calls the flow makes.
vi.mock('@/lib/trip/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/trip/api')>()),
  generateTrip,
  streamGeneration,
}))
// Drive the entitlement gate via controlled hook states; the real classifyGenerateError stays.
vi.mock('@/lib/entitlement', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlement')>()),
  useEntitlement,
}))
// The inbox is now TraysScreen (paper). Its own UI (trays grid, Library banner,
// capture, empty state) is covered by TraysScreen.test.tsx; here we mock it down to
// the one thing the flow needs — a trigger that submits saved-1 for organization — so
// these tests stay about the organize/stream/poll/generate LOGIC, not inbox markup.
type MockTrayCard = { id: string; caption: string | null; normalized_url: string }
vi.mock('@/components/reels/TraysScreen', () => ({
  default: ({ cards, onOrganize, onCreateTrail }: { cards: MockTrayCard[]; onOrganize: (ids: string[]) => void; onCreateTrail: (trayCards: MockTrayCard[]) => void }) => (
    <div>
      {cards.map((c) => <span key={c.id}>{c.caption ?? c.normalized_url}</span>)}
      <button type="button" onClick={() => onOrganize([cards[0]?.id ?? ''])}>mock-plan-trip</button>
      {/* Create-trail (T3.1b): forward the loaded cards straight into the flow's real handler,
          so a test controls the tray's places via the listSavedReelCards mock. */}
      <button type="button" onClick={() => onCreateTrail(cards)}>mock-create-trail</button>
    </div>
  ),
}))
vi.mock('mapbox-gl', () => ({
  default: {
    Map: vi.fn(() => mapInstance),
    Marker: vi.fn(() => {
      const m = { setLngLat: vi.fn(() => m), addTo: vi.fn(() => m), remove: vi.fn() }
      return m
    }),
    LngLatBounds: vi.fn(() => ({ extend: vi.fn() })),
    accessToken: '',
  },
}))
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}))

import SavedReelsFlow, { toReelBriefItem } from '@/components/reels/SavedReelsFlow'
import MapProvider from '@/components/map/MapProvider'
import GenerationProvider from '@/components/generation/GenerationProvider'
import { ApiError } from '@/lib/trip/api'
import type { SavedReelCard, SavedReelPlaceProof } from '@/lib/reels/backend-types'

const NOT_EXHAUSTED = {
  loading: false, isTrialExhausted: false, seatRequested: false,
  requestSeat, requesting: false, canonicalTripId: null, canonicalTripLoading: false,
  refetch: vi.fn(),
}

const cards: SavedReelCard[] = [
  {
    id: 'saved-1', user_id: 'user-1', normalized_url: 'https://www.instagram.com/reel/AAA/',
    source_platform: 'instagram', reel_cache_id: 'cache-1', has_current_cache: true, analysis_status: 'not_analyzed',
    personal_label: null, retry_after: null, analyzed_at: null, created_at: '2026-07-18T00:00:00Z', updated_at: '2026-07-18T00:00:00Z',
    caption: 'Tokyo Tower at sunset', thumbnail_url: 'https://cdn.example/tower.jpg', places: [],
  },
  {
    id: 'saved-2', user_id: 'user-1', normalized_url: 'https://www.instagram.com/reel/BBB/',
    source_platform: 'instagram', reel_cache_id: 'stale-cache', has_current_cache: false, analysis_status: 'not_analyzed',
    personal_label: null, retry_after: null, analyzed_at: null, created_at: '2026-07-18T00:00:00Z', updated_at: '2026-07-18T00:00:00Z',
    caption: null, thumbnail_url: null, places: [],
  },
]

const organizedCards: SavedReelCard[] = [{
  ...cards[0],
  places: [{
    place_id: 'place-1', name: 'Tokyo Tower', lat: 35.6586, lng: 139.7454, country_code: 'JP', country_name: 'Japan',
    evidence_quote: 'Tokyo Tower', source_url: 'https://source.test/tokyo-tower', source_reel_url: cards[0].normalized_url, confidence: 0.95,
  }],
}]

const mixedOrganizedCards: SavedReelCard[] = [
  ...organizedCards,
  {
    ...cards[1],
    places: [{
      place_id: 'place-us', name: 'Golden Gate Bridge', lat: 37.8199, lng: -122.4783,
      country_code: 'US', country_name: 'United States', evidence_quote: 'Golden Gate Bridge',
      source_url: 'https://source.test/golden-gate', source_reel_url: cards[1].normalized_url, confidence: 0.94,
    }],
  },
]

// Builders for the create-trail path (T3.1b): a tray card carrying grounded places, fed to
// the flow's real onCreateTrail via the TraysScreen mock's mock-create-trail button.
function placeProof(over: Partial<SavedReelPlaceProof>): SavedReelPlaceProof {
  return {
    place_id: 'p1', name: 'Place', lat: 0, lng: 0, country_code: 'JP', country_name: 'Japan',
    evidence_quote: 'q', source_url: null, source_reel_url: 'https://ig/reel/x', confidence: 1, ...over,
  }
}
function cardWithPlaces(id: string, caption: string, places: SavedReelPlaceProof[]): SavedReelCard {
  return { ...cards[0], id, caption, places }
}

// Wait for the inbox to load its cards, then trigger organization of saved-1.
async function loadedInbox() {
  await screen.findByText('Tokyo Tower at sunset')
}
function createTrail() {
  fireEvent.click(screen.getByRole('button', { name: 'mock-create-trail' }))
}
function planTrip() {
  fireEvent.click(screen.getByRole('button', { name: 'mock-plan-trip' }))
}

async function startSelectedOrganize() {
  const rendered = render(<MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>)
  await loadedInbox()
  planTrip()
  await screen.findByTestId('organize-globe')
  await waitFor(() => expect(streamOrganize).toHaveBeenCalledTimes(1))
  return {
    onEvent: streamOrganize.mock.calls[0][2] as (event: unknown) => void,
    unmount: rendered.unmount,
  }
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('SavedReelsFlow', () => {
  afterEach(() => { cleanup(); vi.useRealTimers() })

  beforeEach(() => {
    push.mockReset(); getAccessToken.mockResolvedValue('token'); listSavedReelCards.mockReset(); listSavedReelCards.mockResolvedValue(cards)
    startOrganize.mockReset(); startOrganize.mockResolvedValue({ job_id: 'job-1' }); streamOrganize.mockReset(); getOrganizeStatus.mockReset(); getOrganizeStatus.mockResolvedValue({
      job_id: 'job-1', status: 'succeeded', status_message: 'Organized', total_items: 1, processed_items: 1,
      organized_items: 1, location_not_found_items: 0, failed_items: 0,
      items: [{ saved_reel_id: 'saved-1', status: 'organized', place_count: 1, error_message: null }],
    })
    streamOrganize.mockImplementation((_job: string, _token: string, onEvent: (event: unknown) => void) => {
      onEvent({ type: 'stage', stage: 'grounding', msg: 'Grounding places on the globe' })
      return { cancel: vi.fn() }
    })
    generateTrip.mockReset(); generateTrip.mockResolvedValue({ trip_id: 'trip-1' }); streamGeneration.mockReset()
    streamGeneration.mockImplementation((_id: string, _token: string, onEvent: (event: unknown) => void) => {
      onEvent({ type: 'result', content: JSON.stringify({ trip_id: 'trip-1' }) })
      return { cancel: vi.fn() }
    })
    useEntitlement.mockReset(); useEntitlement.mockReturnValue(NOT_EXHAUSTED)
    NOT_EXHAUSTED.refetch.mockClear() // shared module-scope mock — clear call history between tests
    requestSeat.mockReset(); requestSeat.mockResolvedValue(undefined)
  })

  // Reach the PlanSheet (brief phase) via create-trail with one grounded place selected.
  async function reachBrief() {
    listSavedReelCards.mockResolvedValue([cardWithPlaces('r1', 'One-place reel', [placeProof({ place_id: 'p1', name: 'Place 1' })])])
    render(<MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>)
    await screen.findByText('One-place reel')
    createTrail()
    await screen.findByRole('heading', { name: 'Japan' })
    fireEvent.click(screen.getByRole('checkbox', { name: /select Place 1/i }))
    fireEvent.click(screen.getByRole('button', { name: /plan this trip/i }))
    await screen.findByRole('heading', { name: /plan this trip/i })
  }

  it('preserves Saved Reel attribution when a verified place enters the trip brief', () => {
    expect(toReelBriefItem(organizedCards[0].places[0])).toEqual({
      key: 'place:place-1',
      item_type: 'reel_url',
      source: 'web_share_target',
      normalized_reel_url: cards[0].normalized_url,
      requested_place_text: null,
      status: 'places_found',
    })
  })

  it('loads saved Reels into the inbox', async () => {
    render(<MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>)
    expect(await screen.findByText('Tokyo Tower at sunset')).toBeInTheDocument()
  })

  it('organizes selected Reels, shows the replacing globe status, and opens country trays', async () => {
    render(<MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>)
    await loadedInbox()
    planTrip()
    listSavedReelCards.mockResolvedValueOnce(organizedCards)

    expect(await screen.findByTestId('organize-globe')).toBeInTheDocument()
    expect(await screen.findByText('Grounding places on the globe')).toBeInTheDocument()

    await waitFor(() => expect(streamOrganize).toHaveBeenCalledTimes(1))
    const onEvent = streamOrganize.mock.calls[0][2] as (event: unknown) => void
    onEvent({ type: 'result', content: JSON.stringify({ status: 'succeeded' }) })
    await waitFor(() => expect(getOrganizeStatus).toHaveBeenCalledWith('job-1', 'token'))
    expect(await screen.findByRole('heading', { name: 'Japan' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /select Tokyo Tower/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /source reel/i })).toHaveAttribute('href', cards[0].normalized_url)
  })

  it('shows grounded places only from the Reels submitted in the current organize action', async () => {
    render(<MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>)
    await loadedInbox()
    planTrip()
    listSavedReelCards.mockResolvedValueOnce(mixedOrganizedCards)

    await screen.findByTestId('organize-globe')
    await waitFor(() => expect(streamOrganize).toHaveBeenCalledTimes(1))
    const onEvent = streamOrganize.mock.calls[0][2] as (event: unknown) => void
    onEvent({ type: 'result', content: JSON.stringify({ status: 'succeeded' }) })

    expect(await screen.findByRole('heading', { name: 'Japan' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /select Tokyo Tower/i })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'United States' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /select Golden Gate Bridge/i })).not.toBeInTheDocument()
  })

  it('passes selected place_ids through the brief into the existing generation stream', async () => {
    render(<MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>)
    await loadedInbox()
    planTrip()
    listSavedReelCards.mockResolvedValueOnce(organizedCards)
    await screen.findByTestId('organize-globe')
    await waitFor(() => expect(streamOrganize).toHaveBeenCalledTimes(1))
    const onEvent = streamOrganize.mock.calls[0][2] as (event: unknown) => void
    onEvent({ type: 'result', content: JSON.stringify({ status: 'succeeded' }) })
    await screen.findByRole('heading', { name: 'Japan' })
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /select Tokyo Tower/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('checkbox', { name: /select Tokyo Tower/i }))
    fireEvent.click(screen.getByRole('button', { name: /plan this trip/i }))
    pickTripDates()
    fireEvent.click(await screen.findByRole('button', { name: /generate trip/i }))

    await waitFor(() => expect(generateTrip).toHaveBeenCalledWith(
      expect.objectContaining({ place_ids: ['place-1'], reel_urls: [], requested_places: [] }),
      'token',
    ))
    expect(streamGeneration).toHaveBeenCalled()
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/trip/trip-1'))
  })

  // The saved-reels path reaches the same handoff as CreateTripFlow, so it owes the
  // user the same signature moment. Here `result` fires before the lazily-imported
  // Mapbox bundle resolves, so this also covers the relight winning that race.
  it('relights the map to dawn when its generation stream completes', async () => {
    process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN = 'pk.test'
    try {
      render(<MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>)
      await loadedInbox()
      planTrip()
      listSavedReelCards.mockResolvedValueOnce(organizedCards)
      await screen.findByTestId('organize-globe')
      await waitFor(() => expect(streamOrganize).toHaveBeenCalledTimes(1))
      const onEvent = streamOrganize.mock.calls[0][2] as (event: unknown) => void
      onEvent({ type: 'result', content: JSON.stringify({ status: 'succeeded' }) })
      await screen.findByRole('heading', { name: 'Japan' })
      await waitFor(() => expect(screen.getByRole('checkbox', { name: /select Tokyo Tower/i })).toBeInTheDocument())
      fireEvent.click(screen.getByRole('checkbox', { name: /select Tokyo Tower/i }))
      fireEvent.click(screen.getByRole('button', { name: /plan this trip/i }))
      pickTripDates()
      fireEvent.click(await screen.findByRole('button', { name: /generate trip/i }))

      await waitFor(() => expect(push).toHaveBeenCalledWith('/app/trip/trip-1'))
      // The terminal 'result' handler must refetch the entitlement (keeps the gate in sync with a
      // failure refund). Guards against silently dropping the call site.
      expect(NOT_EXHAUSTED.refetch).toHaveBeenCalled()
      await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
      const load = mapInstance.on.mock.calls.find((c) => c[0] === 'load')
      act(() => { (load?.[1] as () => void)?.() })

      expect(mapInstance.setConfigProperty).toHaveBeenCalledWith('basemap', 'lightPreset', 'dawn')
      expect(mapInstance.setConfigProperty).not.toHaveBeenCalledWith('basemap', 'lightPreset', 'night')
    } finally {
      delete process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_TOKEN
    }
  })

  it('returns a failed provider job to the inbox with a persistent retry message', async () => {
    getOrganizeStatus.mockResolvedValueOnce({
      job_id: 'job-1', status: 'failed', status_message: 'Location verification provider unavailable. Try again.',
      total_items: 1, processed_items: 1, organized_items: 0, location_not_found_items: 0, failed_items: 1,
      items: [{ saved_reel_id: 'saved-1', status: 'failed', place_count: 0, error_message: 'provider unavailable' }],
    })

    render(<MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>)
    await loadedInbox()
    planTrip()
    await screen.findByTestId('organize-globe')
    await waitFor(() => expect(streamOrganize).toHaveBeenCalledTimes(1))
    const onEvent = streamOrganize.mock.calls[0][2] as (event: unknown) => void
    onEvent({ type: 'result', content: JSON.stringify({ status: 'failed' }) })

    expect(await screen.findByRole('alert')).toHaveTextContent('Location verification provider unavailable. Try again.')
    planTrip()
    await waitFor(() => expect(startOrganize).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('returns a zero-verified-place result to the inbox without opening an empty tray', async () => {
    getOrganizeStatus.mockResolvedValueOnce({
      job_id: 'job-1', status: 'succeeded', status_message: 'Organized',
      total_items: 1, processed_items: 1, organized_items: 0, location_not_found_items: 1, failed_items: 0,
      items: [{ saved_reel_id: 'saved-1', status: 'location_not_found', place_count: 0, error_message: null }],
    })

    render(<MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>)
    await loadedInbox()
    planTrip()
    await screen.findByTestId('organize-globe')
    await waitFor(() => expect(streamOrganize).toHaveBeenCalledTimes(1))
    const onEvent = streamOrganize.mock.calls[0][2] as (event: unknown) => void
    onEvent({ type: 'result', content: JSON.stringify({ status: 'succeeded' }) })

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not verify any locations/i)
    expect(screen.queryByRole('button', { name: /plan this trip/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'mock-plan-trip' })).toBeInTheDocument()
  })

  it('starts one durable poll when a stream result says the job is still processing', async () => {
    getOrganizeStatus.mockResolvedValue({
      job_id: 'job-1', status: 'processing', status_message: 'Still grounding', total_items: 1, processed_items: 0,
      organized_items: 0, location_not_found_items: 0, failed_items: 0, items: [],
    })
    const { onEvent } = await startSelectedOrganize()
    vi.useFakeTimers()

    await act(async () => {
      onEvent({ type: 'result', content: JSON.stringify({ status: 'processing' }) })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getOrganizeStatus).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)

    await act(async () => {
      vi.advanceTimersByTime(1000)
      await flushMicrotasks()
    })
    expect(getOrganizeStatus).toHaveBeenCalledTimes(2)
  })

  it('clears durable polling before opening trays after a later success', async () => {
    getOrganizeStatus
      .mockResolvedValueOnce({
        job_id: 'job-1', status: 'processing', status_message: 'Still grounding', total_items: 1, processed_items: 0,
        organized_items: 0, location_not_found_items: 0, failed_items: 0, items: [],
      })
      .mockResolvedValueOnce({
        job_id: 'job-1', status: 'succeeded', status_message: 'Organized', total_items: 1, processed_items: 1,
        organized_items: 1, location_not_found_items: 0, failed_items: 0,
        items: [{ saved_reel_id: 'saved-1', status: 'organized', place_count: 1, error_message: null }],
      })
    const { onEvent } = await startSelectedOrganize()
    vi.useFakeTimers()
    listSavedReelCards.mockResolvedValueOnce(organizedCards)

    await act(async () => {
      onEvent({ type: 'result', content: JSON.stringify({ status: 'processing' }) })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getOrganizeStatus).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    await act(async () => {
      vi.advanceTimersByTime(1000)
      await flushMicrotasks()
    })

    expect(screen.getByRole('heading', { name: 'Japan' })).toBeInTheDocument()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears durable polling before returning a later failure to the inbox', async () => {
    getOrganizeStatus
      .mockResolvedValueOnce({
        job_id: 'job-1', status: 'processing', status_message: 'Still grounding', total_items: 1, processed_items: 0,
        organized_items: 0, location_not_found_items: 0, failed_items: 0, items: [],
      })
      .mockResolvedValueOnce({
        job_id: 'job-1', status: 'failed', status_message: 'Provider unavailable', total_items: 1, processed_items: 1,
        organized_items: 0, location_not_found_items: 0, failed_items: 1,
        items: [{ saved_reel_id: 'saved-1', status: 'failed', place_count: 0, error_message: 'provider unavailable' }],
      })
    const { onEvent } = await startSelectedOrganize()
    vi.useFakeTimers()

    await act(async () => {
      onEvent({ type: 'result', content: JSON.stringify({ status: 'processing' }) })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getOrganizeStatus).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    await act(async () => {
      vi.advanceTimersByTime(1000)
      await flushMicrotasks()
    })

    expect(screen.getByRole('alert')).toHaveTextContent('Provider unavailable')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not create duplicate polls for repeated stream results', async () => {
    getOrganizeStatus.mockResolvedValue({
      job_id: 'job-1', status: 'processing', status_message: 'Still grounding', total_items: 1, processed_items: 0,
      organized_items: 0, location_not_found_items: 0, failed_items: 0, items: [],
    })
    const { onEvent } = await startSelectedOrganize()
    vi.useFakeTimers()

    await act(async () => {
      onEvent({ type: 'result', content: JSON.stringify({ status: 'processing' }) })
      onEvent({ type: 'result', content: JSON.stringify({ status: 'processing' }) })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getOrganizeStatus).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('cancels the stream and durable poll when unmounted during organization', async () => {
    const cancel = vi.fn()
    streamOrganize.mockImplementation((_job: string, _token: string, onEvent: (event: unknown) => void) => {
      onEvent({ type: 'stage', stage: 'grounding', msg: 'Grounding places on the globe' })
      return { cancel }
    })
    getOrganizeStatus.mockResolvedValue({
      job_id: 'job-1', status: 'processing', status_message: 'Still grounding', total_items: 1, processed_items: 0,
      organized_items: 0, location_not_found_items: 0, failed_items: 0, items: [],
    })
    const { onEvent, unmount } = await startSelectedOrganize()
    vi.useFakeTimers()

    await act(async () => {
      onEvent({ type: 'result', content: JSON.stringify({ status: 'processing' }) })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(getOrganizeStatus).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    unmount()

    expect(cancel).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not update or stream after unmount during the inbox load', async () => {
    let resolveCards!: (value: SavedReelCard[]) => void
    listSavedReelCards.mockReturnValueOnce(new Promise((resolve) => { resolveCards = resolve }))
    const { unmount } = render(<MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>)
    unmount()
    resolveCards(cards)
    await Promise.resolve(); await Promise.resolve()
    expect(screen.queryByText('Tokyo Tower at sunset')).not.toBeInTheDocument()
    expect(streamOrganize).not.toHaveBeenCalled()
  })

  // --- T3.1b: create-trail from a tray reuses the generate seam (place_ids-only). ---

  it('blocks create-trail for a tray with no grounded places (master B3 step-4 handler guard)', async () => {
    // Reels present, but none organized → the handler must NOT change phase and never generate.
    listSavedReelCards.mockResolvedValue([cardWithPlaces('r1', 'Ungrounded reel', [])])
    render(<MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>)
    await screen.findByText('Ungrounded reel')

    createTrail()

    // Still on the inbox (the mocked TraysScreen surface), CountryTrays never mounted.
    expect(screen.getByRole('button', { name: 'mock-create-trail' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /plan this trip/i })).not.toBeInTheDocument()
    expect(generateTrip).not.toHaveBeenCalled()
  })

  it('dedups a multi-country tray by place_id when opening the picker', async () => {
    // place-1 (JP) appears in two cards; place-us (US) once → each place shows exactly once.
    const jp = placeProof({ place_id: 'place-1', name: 'Tokyo Tower', country_code: 'JP', country_name: 'Japan' })
    const us = placeProof({ place_id: 'place-us', name: 'Golden Gate Bridge', country_code: 'US', country_name: 'United States' })
    listSavedReelCards.mockResolvedValue([
      cardWithPlaces('r1', 'Reel A', [jp]),
      cardWithPlaces('r2', 'Reel B', [jp, us]),
    ])
    render(<MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>)
    await screen.findByText('Reel A')

    createTrail()

    expect(await screen.findByRole('heading', { name: 'Japan' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'United States' })).toBeInTheDocument()
    expect(screen.getAllByRole('checkbox', { name: /select Tokyo Tower/i })).toHaveLength(1)
    expect(screen.getAllByRole('checkbox', { name: /select Golden Gate Bridge/i })).toHaveLength(1)
  })

  it('generates with exactly the 5 selected place_ids and empty reel_urls + requested_places', async () => {
    const places = Array.from({ length: 5 }, (_, i) => placeProof({ place_id: `p${i + 1}`, name: `Place ${i + 1}` }))
    listSavedReelCards.mockResolvedValue([cardWithPlaces('r1', 'Five-place reel', places)])
    render(<MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>)
    await screen.findByText('Five-place reel')

    createTrail()
    await screen.findByRole('heading', { name: 'Japan' })
    for (const cb of screen.getAllByRole('checkbox')) fireEvent.click(cb)
    fireEvent.click(screen.getByRole('button', { name: /plan this trip/i }))
    pickTripDates()
    fireEvent.click(await screen.findByRole('button', { name: /generate trip/i }))

    await waitFor(() => expect(generateTrip).toHaveBeenCalled())
    const request = generateTrip.mock.calls[0][0]
    expect(request.reel_urls).toEqual([])
    expect(request.requested_places).toEqual([])
    expect(request.place_ids).toHaveLength(5)
    expect(new Set(request.place_ids)).toEqual(new Set(['p1', 'p2', 'p3', 'p4', 'p5']))
  })

  it('caps selection at 5: the 6th checkbox is disabled and generate never gets >5 place_ids', async () => {
    const places = Array.from({ length: 6 }, (_, i) => placeProof({ place_id: `p${i + 1}`, name: `Place ${i + 1}` }))
    listSavedReelCards.mockResolvedValue([cardWithPlaces('r1', 'Six-place reel', places)])
    render(<MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>)
    await screen.findByText('Six-place reel')

    createTrail()
    await screen.findByRole('heading', { name: 'Japan' })
    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes).toHaveLength(6)
    for (const cb of checkboxes) fireEvent.click(cb) // the 6th is disabled and cannot toggle

    // Five selected, the untouched 6th checkbox is disabled by CountryTrays' count guard.
    expect(checkboxes.filter((cb) => (cb as HTMLInputElement).checked)).toHaveLength(5)
    expect(checkboxes.some((cb) => (cb as HTMLInputElement).disabled)).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: /plan this trip/i }))
    pickTripDates()
    fireEvent.click(await screen.findByRole('button', { name: /generate trip/i }))

    await waitFor(() => expect(generateTrip).toHaveBeenCalled())
    const request = generateTrip.mock.calls[0][0]
    expect(request.place_ids).toHaveLength(5)
  })

  it('returns to the inbox grid when CountryTrays Back is clicked', async () => {
    render(<MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>)
    await loadedInbox()
    planTrip()
    listSavedReelCards.mockResolvedValueOnce(organizedCards)
    await screen.findByTestId('organize-globe')
    await waitFor(() => expect(streamOrganize).toHaveBeenCalledTimes(1))
    const onEvent = streamOrganize.mock.calls[0][2] as (event: unknown) => void
    onEvent({ type: 'result', content: JSON.stringify({ status: 'succeeded' }) })
    await screen.findByRole('heading', { name: 'Japan' })

    fireEvent.click(screen.getByRole('button', { name: /back/i }))

    // Back on the inbox grid: the picker is gone and the TraysScreen surface is back.
    expect(await screen.findByRole('button', { name: 'mock-plan-trip' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Japan' })).not.toBeInTheDocument()
  })

  it('opens the create-trail picker with zero preselection even after a prior selection (no-auto-submit, M4)', async () => {
    const places = [placeProof({ place_id: 'p1', name: 'Place 1' }), placeProof({ place_id: 'p2', name: 'Place 2' })]
    listSavedReelCards.mockResolvedValue([cardWithPlaces('r1', 'Two-place reel', places)])
    render(<MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>)
    await screen.findByText('Two-place reel')

    // First entry: select both places.
    createTrail()
    await screen.findByRole('heading', { name: 'Japan' })
    for (const cb of screen.getAllByRole('checkbox')) fireEvent.click(cb)
    expect(screen.getAllByRole('checkbox').filter((cb) => (cb as HTMLInputElement).checked)).toHaveLength(2)

    // Back to the inbox grid — Back does NOT reset the selection — then re-enter create-trail.
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    await screen.findByRole('button', { name: 'mock-create-trail' })
    createTrail()
    await screen.findByRole('heading', { name: 'Japan' })

    // The picker reopens with NOTHING checked: onCreateTrail's setSelectedPlaceIds([]) reset is load-bearing.
    expect(screen.getAllByRole('checkbox').every((cb) => !(cb as HTMLInputElement).checked)).toBe(true)
  })

  it('clears a prior failed-generate error when re-entering create-trail (Codex C-new-1)', async () => {
    const places = [placeProof({ place_id: 'p1', name: 'Place 1' })]
    listSavedReelCards.mockResolvedValue([cardWithPlaces('r1', 'One-place reel', places)])
    generateTrip.mockRejectedValueOnce(new Error('generation service down'))

    render(<MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>)
    await screen.findByText('One-place reel')

    // Attempt 1: create-trail → pick → Plan → brief → Generate FAILS → the error surfaces on the brief.
    createTrail()
    await screen.findByRole('heading', { name: 'Japan' })
    fireEvent.click(screen.getByRole('checkbox', { name: /select Place 1/i }))
    fireEvent.click(screen.getByRole('button', { name: /plan this trip/i }))
    pickTripDates()
    fireEvent.click(await screen.findByRole('button', { name: /generate trip/i }))
    expect(await screen.findByText(/generation service down/i)).toBeInTheDocument()

    // Back out to the inbox grid (brief → trays → inbox), then re-enter create-trail.
    fireEvent.click(screen.getByRole('button', { name: /back to places/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^back$/i }))
    await screen.findByRole('button', { name: 'mock-create-trail' })
    createTrail()
    await screen.findByRole('heading', { name: 'Japan' })
    fireEvent.click(screen.getByRole('button', { name: /plan this trip/i }))

    // The brief re-opens WITHOUT the prior attempt's stale error.
    expect(screen.queryByText(/generation service down/i)).not.toBeInTheDocument()
  })

  it('clears a prior failed-generate error when a later organize run opens the picker (organize-finish clear, C-new-1)', async () => {
    const places = [placeProof({ place_id: 'p1', name: 'Place 1' })]
    listSavedReelCards.mockResolvedValue([cardWithPlaces('r1', 'One-place reel', places)])
    generateTrip.mockRejectedValueOnce(new Error('generation service down'))

    render(<MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>)
    await screen.findByText('One-place reel')

    // Fail a create-trail generate → the error surfaces on the brief.
    createTrail()
    await screen.findByRole('heading', { name: 'Japan' })
    fireEvent.click(screen.getByRole('checkbox', { name: /select Place 1/i }))
    fireEvent.click(screen.getByRole('button', { name: /plan this trip/i }))
    pickTripDates()
    fireEvent.click(await screen.findByRole('button', { name: /generate trip/i }))
    expect(await screen.findByText(/generation service down/i)).toBeInTheDocument()

    // Back to the inbox, then run ORGANIZE (not create-trail): its finish opens the picker.
    fireEvent.click(screen.getByRole('button', { name: /back to places/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^back$/i }))
    planTrip()
    await screen.findByTestId('organize-globe')
    await waitFor(() => expect(streamOrganize).toHaveBeenCalledTimes(1))
    const onEvent = streamOrganize.mock.calls[0][2] as (event: unknown) => void
    onEvent({ type: 'result', content: JSON.stringify({ status: 'succeeded' }) })
    await screen.findByRole('heading', { name: 'Japan' })
    fireEvent.click(screen.getByRole('checkbox', { name: /select Place 1/i }))
    fireEvent.click(screen.getByRole('button', { name: /plan this trip/i }))

    // The organize→trays finish cleared the error, so the brief re-opens clean.
    expect(screen.queryByText(/generation service down/i)).not.toBeInTheDocument()
  })

  // --- Entitlement gate (Task 9) — the gate lives here in the flow; PlanSheet stays dumb. ---

  it('renders the trial-exhausted card in place of Generate in the plan sheet when exhausted', async () => {
    useEntitlement.mockReturnValue({ ...NOT_EXHAUSTED, isTrialExhausted: true })
    await reachBrief()

    expect(await screen.findByRole('button', { name: 'Request a seat' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /generate/i })).not.toBeInTheDocument()
  })

  it('shows the card after generateTrip rejects with a 403 trial_exhausted (post-hoc catch)', async () => {
    generateTrip.mockRejectedValueOnce(new ApiError(403, 'trial_exhausted', 'Your free trip is already planned.'))
    await reachBrief()
    pickTripDates()
    fireEvent.click(await screen.findByRole('button', { name: /generate trip/i }))

    expect(await screen.findByRole('button', { name: 'Request a seat' })).toBeInTheDocument()
    expect(streamGeneration).not.toHaveBeenCalled()
  })

  it('surfaces a non-trial 409 message verbatim via ApiError and does NOT render the card', async () => {
    const message = 'That request is already being processed — please retry.'
    generateTrip.mockRejectedValueOnce(new ApiError(409, 'conflict_retry', message))
    await reachBrief()
    pickTripDates()
    fireEvent.click(await screen.findByRole('button', { name: /generate trip/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(screen.queryByRole('button', { name: /request a seat/i })).not.toBeInTheDocument()
  })

  it('catches a rejected requestSeat and surfaces it (no unhandled rejection)', async () => {
    requestSeat.mockRejectedValueOnce(new Error('Seat service is down.'))
    useEntitlement.mockReturnValue({ ...NOT_EXHAUSTED, isTrialExhausted: true })
    await reachBrief()

    fireEvent.click(await screen.findByRole('button', { name: 'Request a seat' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Seat service is down.')
    expect(requestSeat).toHaveBeenCalledTimes(1)
  })
})

describe('an agent-started extraction shows progress without a reload', () => {
  /* The reported journey, end to end: a tool saves reels and starts extraction, and the page
     shows "Not analyzed" for the whole run, changing only after a manual refresh once it is
     already done — indistinguishable from the save having failed.

     Live status is DERIVED from the organize job, never written into saved_reels. Persisting it
     there looked simpler and is worse: nothing owns those rows, so a job failing between its
     steps strands a reel reading "Analyzing…" forever, and an idempotent retry drags a reel that
     is genuinely processing back to "queued". The job's items already carry the truth. */
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
  afterEach(() => { vi.useRealTimers() })

  function renderInRegistry() {
    return render(
      <WebMcpRegistryProvider>
        <MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>
      </WebMcpRegistryProvider>,
    )
  }

  const job = (status: string, itemStatus: string) => ({
    job_id: 'job-1', status, status_message: '', total_items: 1,
    processed_items: 0, organized_items: 0, location_not_found_items: 0, failed_items: 0,
    items: [{ saved_reel_id: 'saved-1', status: itemStatus, place_count: 0, error_message: null }],
  })

  it('adopts a tool-started job and polls it', async () => {
    // The gap this closes: the page follows a job IT started (jobId + SSE), but an agent starts
    // one outside that state entirely, so the run was invisible here. What the adopted job then
    // renders is unit-tested in lib/reels/__tests__/overlay-live-status.test.ts.
    listSavedReelCards.mockResolvedValue([{ ...cards[0], analysis_status: 'not_analyzed' }])
    getOrganizeStatus.mockClear()
    getOrganizeStatus.mockResolvedValue(job('processing', 'processing'))
    let slot: { current: ((id: string) => void) | null } | null = null
    function Capture() {
      slot = useWebMcpRegistry().adoptOrganizeJob
      return null
    }
    render(
      <WebMcpRegistryProvider>
        <MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>
        <Capture />
      </WebMcpRegistryProvider>,
    )
    await act(async () => { await Promise.resolve() })
    expect(getOrganizeStatus).not.toHaveBeenCalled()      // nothing adopted yet

    await act(async () => { slot?.current?.('job-1'); await Promise.resolve() })
    await waitFor(() => expect(getOrganizeStatus).toHaveBeenCalledWith('job-1', 'token'))

    const first = getOrganizeStatus.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(getOrganizeStatus.mock.calls.length).toBeGreaterThan(first)
  })

  it('refetches as each reel lands, not only when the whole job ends', async () => {
    /* Two reels: the first finished while the second was still extracting, and its card had
       nowhere to get its real status and places from until the very end — so it visibly went
       back to "Not analyzed". The list must catch up per reel. */
    listSavedReelCards.mockResolvedValue([{ ...cards[0], analysis_status: 'not_analyzed' }])
    getOrganizeStatus.mockClear()
    let slot: { current: ((id: string) => void) | null } | null = null
    function Capture() {
      slot = useWebMcpRegistry().adoptOrganizeJob
      return null
    }
    const twoItems = (first: string, second: string, status: string) => ({
      job_id: 'job-1', status, status_message: '', total_items: 2,
      processed_items: 0, organized_items: 0, location_not_found_items: 0, failed_items: 0,
      items: [
        { saved_reel_id: 'saved-1', status: first, place_count: 0, error_message: null },
        { saved_reel_id: 'saved-2', status: second, place_count: 0, error_message: null },
      ],
    })

    getOrganizeStatus.mockResolvedValue(twoItems('processing', 'queued', 'processing'))
    render(
      <WebMcpRegistryProvider>
        <MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>
        <Capture />
      </WebMcpRegistryProvider>,
    )
    await act(async () => { await Promise.resolve() })
    await act(async () => { slot?.current?.('job-1'); await Promise.resolve() })
    await waitFor(() => expect(getOrganizeStatus).toHaveBeenCalled())

    const before = listSavedReelCards.mock.calls.length
    // First reel lands. The JOB is still processing — the old code refetched nothing here.
    getOrganizeStatus.mockResolvedValue(twoItems('organized', 'processing', 'processing'))
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(listSavedReelCards.mock.calls.length).toBeGreaterThan(before)

    // ...and not again on the next tick, because nothing new settled.
    const afterFirst = listSavedReelCards.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(listSavedReelCards.mock.calls.length).toBe(afterFirst)
  })

  it('keeps following the first job when a second one is adopted', async () => {
    /* The backend does NOT enforce one active organize job per user: creation rejects only a
       batch that OVERLAPS an active job's reels, so two disjoint batches run side by side. A
       single job slot meant a second save_reels while the first was still extracting silently
       abandoned it, leaving its cards stale. */
    listSavedReelCards.mockResolvedValue([{ ...cards[0], analysis_status: 'not_analyzed' }])
    getOrganizeStatus.mockClear()
    getOrganizeStatus.mockResolvedValue(job('processing', 'processing'))
    let slot: { current: ((id: string) => void) | null } | null = null
    function Capture() {
      slot = useWebMcpRegistry().adoptOrganizeJob
      return null
    }
    render(
      <WebMcpRegistryProvider>
        <MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>
        <Capture />
      </WebMcpRegistryProvider>,
    )
    await act(async () => { await Promise.resolve() })
    await act(async () => { slot?.current?.('job-1'); await Promise.resolve() })
    await act(async () => { slot?.current?.('job-2'); await Promise.resolve() })

    getOrganizeStatus.mockClear()
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    const polled = getOrganizeStatus.mock.calls.map((c) => c[0])
    expect(polled).toContain('job-1')      // the first job is still being followed
    expect(polled).toContain('job-2')
  })

  it('stops following the oldest job once the batch is full', async () => {
    /* A job is normally retired when it reaches a terminal status. One that NEVER does - deleted,
       permanently unreadable - is never retired, so an unbounded set would poll it for the life of
       the page and grow the batch on every save_reels call. Oldest out at the cap. */
    listSavedReelCards.mockResolvedValue([{ ...cards[0], analysis_status: 'not_analyzed' }])
    getOrganizeStatus.mockClear()
    getOrganizeStatus.mockResolvedValue(job('processing', 'processing'))
    let slot: { current: ((id: string) => void) | null } | null = null
    function Capture() {
      slot = useWebMcpRegistry().adoptOrganizeJob
      return null
    }
    render(
      <WebMcpRegistryProvider>
        <MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>
        <Capture />
      </WebMcpRegistryProvider>,
    )
    await act(async () => { await Promise.resolve() })
    for (let i = 1; i <= 10; i += 1) {
      await act(async () => { slot?.current?.(`job-${i}`); await Promise.resolve() })
    }

    getOrganizeStatus.mockClear()
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    const polled = new Set(getOrganizeStatus.mock.calls.map((c) => c[0]))
    expect(polled.size).toBe(8)
    expect(polled.has('job-1')).toBe(false)   // dropped
    expect(polled.has('job-2')).toBe(false)
    expect(polled.has('job-3')).toBe(true)    // the 8 most recent survive
    expect(polled.has('job-10')).toBe(true)
  })

  it('keeps other jobs moving when one job\'s status read fails', async () => {
    /* Promise.all rejected the whole batch on a single bad read, so one unreadable job id stalled
       EVERY adopted job for the rest of the page mount — and nothing evicts a permanently bad id.
       Each job has to advance on its own. */
    listSavedReelCards.mockResolvedValue([{ ...cards[0], analysis_status: 'not_analyzed' }])
    let slot: { current: ((id: string) => void) | null } | null = null
    function Capture() {
      slot = useWebMcpRegistry().adoptOrganizeJob
      return null
    }
    getOrganizeStatus.mockImplementation(async (id: string) => {
      if (id === 'job-bad') throw new Error('404 gone')
      return { ...job('processing', 'organized'), job_id: id }
    })
    render(
      <WebMcpRegistryProvider>
        <MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>
        <Capture />
      </WebMcpRegistryProvider>,
    )
    await act(async () => { await Promise.resolve() })

    // Adopt the BAD id first: under Promise.all its rejection took the whole batch with it, so
    // the good job never got a chance to report its finished item.
    const before = listSavedReelCards.mock.calls.length
    listSavedReelCards.mockResolvedValue(organizedCards)
    await act(async () => { slot?.current?.('job-bad'); await Promise.resolve() })
    await act(async () => { slot?.current?.('job-good'); await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })

    expect(getOrganizeStatus.mock.calls.map((c) => c[0])).toContain('job-good')
    // The good job's finished item still triggers its refetch despite its neighbour throwing.
    expect(listSavedReelCards.mock.calls.length).toBeGreaterThan(before)
    getOrganizeStatus.mockReset()
  })

  it('does not retire an item when its refetch fails', async () => {
    /* Ids were marked settled BEFORE the reload succeeded, so one failed read retired the item
       forever — reinstating, invisibly, the stale card this whole mechanism exists to prevent. */
    listSavedReelCards.mockResolvedValue([{ ...cards[0], analysis_status: 'not_analyzed' }])
    getOrganizeStatus.mockClear()
    let slot: { current: ((id: string) => void) | null } | null = null
    function Capture() {
      slot = useWebMcpRegistry().adoptOrganizeJob
      return null
    }
    getOrganizeStatus.mockResolvedValue(job('processing', 'organized'))
    render(
      <WebMcpRegistryProvider>
        <MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>
        <Capture />
      </WebMcpRegistryProvider>,
    )
    await act(async () => { await Promise.resolve() })

    listSavedReelCards.mockRejectedValueOnce(new Error('supabase blip'))
    await act(async () => { slot?.current?.('job-1'); await Promise.resolve() })

    // The failed read must be retried on the next tick, not treated as done.
    const before = listSavedReelCards.mock.calls.length
    listSavedReelCards.mockResolvedValue(organizedCards)
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(listSavedReelCards.mock.calls.length).toBeGreaterThan(before)
  })

  it('stops polling once the job is terminal', async () => {
    listSavedReelCards.mockResolvedValue([{ ...cards[0], analysis_status: 'not_analyzed' }])
    let slot: { current: ((id: string) => void) | null } | null = null
    function Capture() {
      slot = useWebMcpRegistry().adoptOrganizeJob
      return null
    }
    render(
      <WebMcpRegistryProvider>
        <MapProvider><GenerationProvider><SavedReelsFlow /></GenerationProvider></MapProvider>
        <Capture />
      </WebMcpRegistryProvider>,
    )
    await act(async () => { await Promise.resolve() })

    getOrganizeStatus.mockResolvedValue(job('succeeded', 'organized'))
    await act(async () => { slot?.current?.('job-1'); await Promise.resolve() })
    const settled = getOrganizeStatus.mock.calls.length

    // A terminal job ends the poll on its own — no timeout to guess at, and no timer left running
    // on a library page.
    await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
    expect(getOrganizeStatus.mock.calls.length).toBe(settled)
  })

  it('does not poll at all when no agent job was adopted', async () => {
    listSavedReelCards.mockResolvedValue([{ ...cards[0], analysis_status: 'not_analyzed' }])
    getOrganizeStatus.mockClear()
    renderInRegistry()
    await act(async () => { await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
    expect(getOrganizeStatus).not.toHaveBeenCalled()
  })
})
