import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { pickTripDates } from '@/test/pickTripDates'
import { WebMcpRegistryProvider, useWebMcpRegistry } from '@/components/webmcp/WebMcpRegistry'
import { requestViewIntent, resetViewIntent, takeViewIntent } from '@/lib/webmcp/view-intent'
import {
  ORGANIZE_FAILED_MESSAGE, organizeJobs, recordOrganizeFailure, resetOrganizeJobs, trackOrganizeJob,
} from '@/lib/reels/organize-jobs'

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
  default: ({ cards, onOrganize, onCreateTrail, revealLibrary = 0 }: { cards: MockTrayCard[]; onOrganize: (ids: string[]) => void; onCreateTrail: (trayCards: MockTrayCard[]) => void; revealLibrary?: number }) => (
    <div>
      {cards.map((c) => <span key={c.id}>{c.caption ?? c.normalized_url}</span>)}
      <button type="button" onClick={() => onOrganize([cards[0]?.id ?? ''])}>mock-plan-trip</button>
      {/* Create-trail (T3.1b): forward the loaded cards straight into the flow's real handler,
          so a test controls the tray's places via the listSavedReelCards mock. */}
      <button type="button" onClick={() => onCreateTrail(cards)}>mock-create-trail</button>
      {/* The reveal seam, rendered so this file can assert the DECISION the flow makes — which
          phases forward an agent's "show me the library" and which drop it. What the number then
          DOES on screen belongs to the real component, and is pinned in TraysScreen.test.tsx. */}
      <span data-testid="library-reveals">{revealLibrary}</span>
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
import GenerationProvider, { useGeneration, type GenerationApi } from '@/components/generation/GenerationProvider'
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

/* The adopted-job set lives in a module, so it survives a render the way it survives a page —
   which is the whole point of it, and exactly why every test in this file has to start from
   empty. */
beforeEach(() => { resetOrganizeJobs() })

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

  // --- A run that ends badly must give the user the page back (Codex HIGH #2) ---
  //
  // The shell navigates on success ONLY, and this page's own `phase` stays 'generating' until
  // something moves it. So a terminal {error} result — or a stream that gives up — left the
  // GenerationScene wait screen on screen for the rest of the session with no route out of it.

  async function generateFromBrief() {
    await reachBrief()
    pickTripDates()
    fireEvent.click(await screen.findByRole('button', { name: /generate trip/i }))
  }

  it('returns to the brief with the reason when the run ends in a failed result', async () => {
    streamGeneration.mockImplementation((_id: string, _token: string, onEvent: (event: unknown) => void) => {
      onEvent({ type: 'result', content: JSON.stringify({ error: 'lease lost' }) })
      return { cancel: vi.fn() }
    })
    await generateFromBrief()

    expect(await screen.findByRole('button', { name: /generate trip/i })).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be finished/i)
    expect(push).not.toHaveBeenCalled()
  })

  it('returns to the brief when the stream gives up, without claiming the trip died', async () => {
    // 'unknown' is not 'failed': the durable job may well still be running, so the copy must not
    // send the user to spend a second generation on a trip that is about to land.
    streamGeneration.mockImplementation((
      _id: string, _token: string, _onEvent: (event: unknown) => void, _onReset: () => void, onFail: () => void,
    ) => {
      onFail()
      return { cancel: vi.fn() }
    })
    await generateFromBrief()

    expect(await screen.findByRole('button', { name: /generate trip/i })).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent(/lost contact/i)
    expect(push).not.toHaveBeenCalled()
  })

  it('lets the user try again after a failed run, and clears the old error', async () => {
    // Leaving the wait screen is only half the way out — the retry has to actually reach the
    // backend, which it cannot if the shell's single-run lock is still held by the dead run.
    streamGeneration.mockImplementationOnce((_id: string, _token: string, onEvent: (event: unknown) => void) => {
      onEvent({ type: 'result', content: JSON.stringify({ error: 'lease lost' }) })
      return { cancel: vi.fn() }
    })
    await generateFromBrief()
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be finished/i)

    fireEvent.click(await screen.findByRole('button', { name: /generate trip/i }))
    await waitFor(() => expect(generateTrip).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/trip/trip-1'))
  })

  it('reports the retry’s own ending, not the previous run’s', async () => {
    /* The exit has to key off the run's status CHANGING, not off the phase. A retry sets the phase
       back to 'generating' while the dead run's terminal status is still the current one; an
       effect that also watches the phase fires again there, decides the fresh run has already
       ended, and freezes the first run's reason on screen — so a second run that merely lost
       contact is reported as a trip that died. */
    streamGeneration
      .mockImplementationOnce((_id: string, _token: string, onEvent: (event: unknown) => void) => {
        onEvent({ type: 'result', content: JSON.stringify({ error: 'lease lost' }) })
        return { cancel: vi.fn() }
      })
      .mockImplementationOnce((
        _id: string, _token: string, _onEvent: (event: unknown) => void, _onReset: () => void, onFail: () => void,
      ) => {
        onFail()
        return { cancel: vi.fn() }
      })
    await generateFromBrief()
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be finished/i)

    fireEvent.click(await screen.findByRole('button', { name: /generate trip/i }))
    await waitFor(() => expect(streamGeneration).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/lost contact/i))
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

  it('follows a job that was started while this page was not mounted', async () => {
    /* The reported reproduction, and the one a page-local job set could never survive: a finished
       generation navigates to the trip, which unmounts this page while the organize request is
       still in flight. Coming back to /app has to show the job running — not "Not analyzed", which
       is what the user complained about in the first place. */
    listSavedReelCards.mockResolvedValue([{ ...cards[0], analysis_status: 'not_analyzed' }])
    getOrganizeStatus.mockClear()
    getOrganizeStatus.mockResolvedValue(job('processing', 'processing'))

    trackOrganizeJob('job-1')       // nothing is mounted at this moment; that is the point
    renderInRegistry()

    await waitFor(() => expect(getOrganizeStatus).toHaveBeenCalledWith('job-1', 'token'))
  })

  it('retires a finished job from the shared set, not just from its own state', async () => {
    // Otherwise the next mount picks a terminal job straight back up and polls it for ever.
    listSavedReelCards.mockResolvedValue([{ ...cards[0], analysis_status: 'not_analyzed' }])
    getOrganizeStatus.mockClear()
    getOrganizeStatus.mockResolvedValue(job('succeeded', 'organized'))

    trackOrganizeJob('job-1')
    renderInRegistry()

    await waitFor(() => expect(organizeJobs().jobIds).toEqual([]))
  })

  it('tells the user when the post-run organize could not be started', async () => {
    /* Swallowed is right for the trip and wrong for the library: those reels are saved with no
       places and, before this, nothing anywhere said why. */
    listSavedReelCards.mockResolvedValue([{ ...cards[0], analysis_status: 'not_analyzed' }])
    recordOrganizeFailure({ savedReelIds: ['saved-1'], message: ORGANIZE_FAILED_MESSAGE })

    renderInRegistry()

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not organize the Reels/i)
  })

  it('drops that notice once the user organizes the reels it names', async () => {
    listSavedReelCards.mockResolvedValue([{ ...cards[0], analysis_status: 'not_analyzed' }])
    recordOrganizeFailure({ savedReelIds: ['saved-1'], message: ORGANIZE_FAILED_MESSAGE })
    startOrganize.mockResolvedValue({ job_id: 'job-retry' })

    renderInRegistry()
    await screen.findByRole('alert')

    // TraysScreen is mocked down to a button that organizes the first card — 'saved-1'.
    fireEvent.click(await screen.findByRole('button', { name: 'mock-plan-trip' }))

    await waitFor(() => expect(organizeJobs().failure).toBeNull())
  })

  it('drops a notice whose reels have since been organized by something else', async () => {
    /* The notice is about reels with no places, not about a request that failed once. An overlap
       409 is the case that makes this load-bearing: the batch was refused BECAUSE another job was
       reading one of these, so a notice that could only be cleared by hand would sit there for
       ever over reels that were organized minutes ago. */
    recordOrganizeFailure({ savedReelIds: ['saved-1'], message: ORGANIZE_FAILED_MESSAGE })
    listSavedReelCards.mockResolvedValue([{ ...organizedCards[0], analysis_status: 'organized' }])

    renderInRegistry()

    await waitFor(() => expect(organizeJobs().failure).toBeNull())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps a notice up when a card it names could not be read', async () => {
    // An unreadable library is not evidence the reels were organized, and clearing on a vacuous
    // `every` over zero loaded cards would erase the notice precisely when it cannot be checked.
    recordOrganizeFailure({ savedReelIds: ['saved-1'], message: ORGANIZE_FAILED_MESSAGE })
    listSavedReelCards.mockRejectedValue(new Error('supabase down'))

    renderInRegistry()

    await screen.findByRole('alert')
    expect(organizeJobs().failure?.savedReelIds).toEqual(['saved-1'])
  })

  it('keeps a notice up while only SOME of its reels have been organized', async () => {
    // Half-done is not done: the other reel still has no places and nothing else would say so.
    recordOrganizeFailure({ savedReelIds: ['saved-1', 'saved-2'], message: ORGANIZE_FAILED_MESSAGE })
    listSavedReelCards.mockResolvedValue([
      { ...cards[0], analysis_status: 'organized' },
      { ...cards[1], analysis_status: 'not_analyzed' },
    ])

    renderInRegistry()

    await screen.findByRole('alert')
    expect(organizeJobs().failure?.savedReelIds).toEqual(['saved-1', 'saved-2'])
  })

  it('keeps the notice up when the user organizes something else', async () => {
    // A different batch is no evidence that the reels which failed were ever read.
    listSavedReelCards.mockResolvedValue([{ ...cards[0], analysis_status: 'not_analyzed' }])
    recordOrganizeFailure({ savedReelIds: ['saved-elsewhere'], message: ORGANIZE_FAILED_MESSAGE })
    startOrganize.mockResolvedValue({ job_id: 'job-retry' })

    renderInRegistry()
    await screen.findByRole('alert')
    fireEvent.click(await screen.findByRole('button', { name: 'mock-plan-trip' }))

    await waitFor(() => expect(startOrganize).toHaveBeenCalled())
    expect(organizeJobs().failure?.savedReelIds).toEqual(['saved-elsewhere'])
  })
})

describe('a run the AGENT started owns the page too, and says why when it ends', () => {
  /* Codex HIGH: F2 only ever covered the run this page starts itself.
     An agent-started run from the inbox showed the wait screen and then dropped silently back to
     the inbox on failure — the reason reached PlanSheet, which the user was not looking at. From
     the trays or mid-organize it was worse: those returns came BEFORE the shell-run check, so the
     wait screen never appeared at all and the run was invisible on the page that owns generation.

     The active shell run is now the first render branch, whoever started it. Approval is what
     makes that takeover intentional, and `phase`, trays, selection and brief all survive it — so
     a run that dies hands the user back the workflow they were in, with the reason on it. */

  let shellApi: GenerationApi | null = null
  function ShellProbe() { shellApi = useGeneration(); return null }

  function renderFlow() {
    return render(
      <MapProvider><GenerationProvider><ShellProbe /><SavedReelsFlow /></GenerationProvider></MapProvider>,
    )
  }

  let emit: ((event: unknown) => void) | null = null

  beforeEach(() => {
    emit = null
    shellApi = null
    push.mockReset()
    getAccessToken.mockResolvedValue('token')
    listSavedReelCards.mockReset(); listSavedReelCards.mockResolvedValue(cards)
    generateTrip.mockReset(); generateTrip.mockResolvedValue({ trip_id: 'trip-1' })
    useEntitlement.mockReset(); useEntitlement.mockReturnValue(NOT_EXHAUSTED)
    // Hold the stream open so the test decides when — and how — the run ends.
    streamGeneration.mockReset()
    streamGeneration.mockImplementation((_id: string, _token: string, onEvent: (event: unknown) => void) => {
      emit = onEvent
      return { cancel: vi.fn() }
    })
  })

  /** Starts a run the way plan_trip_from_reels does: through the shell's lock, not this page. */
  async function agentStarts(tripId = 'trip-agent') {
    await act(async () => { shellApi!.reserve()!.begin(tripId) })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await waitFor(() => expect(streamGeneration).toHaveBeenCalled())
  }

  async function runEnds(event: unknown) {
    await act(async () => { emit!(event); await Promise.resolve() })
  }

  const FAILED_RESULT = { type: 'result', content: JSON.stringify({ error: 'lease lost' }) }

  it('takes the inbox with the wait screen, and hands it back carrying the reason', async () => {
    renderFlow()
    await loadedInbox()

    await agentStarts()
    expect(await screen.findByTestId('generation-progress')).toBeInTheDocument()

    await runEnds(FAILED_RESULT)

    expect(await screen.findByText('Tokyo Tower at sunset')).toBeInTheDocument()
    expect(await screen.findByText(/could not be finished/i)).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })

  it('takes the TRAYS with the wait screen — those returns used to win outright', async () => {
    listSavedReelCards.mockResolvedValue([
      cardWithPlaces('r1', 'One-place reel', [placeProof({ place_id: 'p1', name: 'Place 1' })]),
    ])
    renderFlow()
    await screen.findByText('One-place reel')
    createTrail()
    await screen.findByRole('heading', { name: 'Japan' })
    fireEvent.click(screen.getByRole('checkbox', { name: /select Place 1/i }))

    await agentStarts()

    expect(await screen.findByTestId('generation-progress')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Japan' })).not.toBeInTheDocument()
  })

  it('gives the trays back with the selection intact, and the reason on them', async () => {
    // Losing the picked places to somebody else's failed run would make the takeover a cost the
    // user never agreed to. Nothing about the trays is owned by the shell, so nothing is lost.
    listSavedReelCards.mockResolvedValue([
      cardWithPlaces('r1', 'One-place reel', [placeProof({ place_id: 'p1', name: 'Place 1' })]),
    ])
    renderFlow()
    await screen.findByText('One-place reel')
    createTrail()
    await screen.findByRole('heading', { name: 'Japan' })
    fireEvent.click(screen.getByRole('checkbox', { name: /select Place 1/i }))

    await agentStarts()
    await runEnds(FAILED_RESULT)

    expect(await screen.findByRole('heading', { name: 'Japan' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /select Place 1/i })).toBeChecked()
    expect(await screen.findByText(/could not be finished/i)).toBeInTheDocument()
  })

  it('says the reason ONCE when the user is in the brief', async () => {
    /* PlanSheet renders the same message through its `error` prop. A second copy from the
       page-level notice would be two alerts saying the same thing, and would break every
       existing getByRole('alert') on this screen. */
    listSavedReelCards.mockResolvedValue([
      cardWithPlaces('r1', 'One-place reel', [placeProof({ place_id: 'p1', name: 'Place 1' })]),
    ])
    renderFlow()
    await screen.findByText('One-place reel')
    createTrail()
    await screen.findByRole('heading', { name: 'Japan' })
    fireEvent.click(screen.getByRole('checkbox', { name: /select Place 1/i }))
    fireEvent.click(screen.getByRole('button', { name: /plan this trip/i }))
    await screen.findByRole('heading', { name: /plan this trip/i })

    await agentStarts()
    await runEnds(FAILED_RESULT)

    const alerts = await screen.findAllByText(/could not be finished/i)
    expect(alerts).toHaveLength(1)
  })

  it('does not claim the trip died when the stream merely lost contact', async () => {
    // 'unknown' is not 'failed': the durable job may still land, and telling the user otherwise
    // spends their allowance on a trip they are about to receive.
    renderFlow()
    await loadedInbox()
    await agentStarts()
    await runEnds({ type: 'result', content: 'not json at all' })

    expect(await screen.findByText(/lost contact/i)).toBeInTheDocument()
    expect(screen.queryByText(/could not be finished/i)).not.toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })
})

/* The page follows the agent (arriving from another route).
   `save_reels` and `plan_trip_from_reels` used to write to the database and return, leaving the
   browser wherever it was: from /app/settings the agent reported success while the screen sat
   still, and a 60-180s generation was invisible until it teleported the user to a finished trip.
   GlobalTools pushes the route; this component is what tells it the page actually arrived. */
describe('SavedReelsFlow is where an agent action lands', () => {
  function renderFlow() {
    return render(<MapProvider><GenerationProvider><ShellProbe /><SavedReelsFlow /></GenerationProvider></MapProvider>)
  }

  let shellApi: GenerationApi | null = null
  function ShellProbe() { shellApi = useGeneration(); return null }
  let emitToRun: ((event: unknown) => void) | null = null

  beforeEach(() => {
    shellApi = null
    emitToRun = null
    push.mockReset()
    getAccessToken.mockResolvedValue('token')
    listSavedReelCards.mockReset(); listSavedReelCards.mockResolvedValue(cards)
    useEntitlement.mockReset(); useEntitlement.mockReturnValue(NOT_EXHAUSTED)
    streamGeneration.mockReset()
    // Held open, so the test decides when — and how — the run ends.
    streamGeneration.mockImplementation((_id: string, _token: string, onEvent: (event: unknown) => void) => {
      emitToRun = onEvent
      return { cancel: vi.fn() }
    })
  })

  afterEach(() => { resetViewIntent() })

  /** Resolved yet? Asked without hanging the test on a promise that may never settle. */
  const isSettled = (p: Promise<void>) => Promise.race([p.then(() => true), Promise.resolve().then(() => false)])

  it('releases a tool waiting for the page, as soon as it mounts', async () => {
    // The arrival case. The intent is raised on another route, before this component exists —
    // which is exactly why it cannot live in React state anywhere below the router.
    const { settled } = requestViewIntent('saved-reels')
    expect(await isSettled(settled)).toBe(false)
    renderFlow()
    await loadedInbox()
    expect(await isSettled(settled)).toBe(true)
  })

  it('releases a tool that asked while the user was already here', async () => {
    renderFlow()
    await loadedInbox()
    const { settled } = requestViewIntent('saved-reels')
    await waitFor(async () => { expect(await isSettled(settled)).toBe(true) })
  })

  it('takes the intent exactly once — a return trip must not replay it', async () => {
    /* Single use. Without it, every remount of this page would re-apply the last thing an agent
       asked for: press Back, come forward again, and get yanked somewhere you did not ask to be. */
    requestViewIntent('saved-reels')
    const first = renderFlow()
    await loadedInbox()
    first.unmount()
    renderFlow()
    await loadedInbox()
    expect(takeViewIntent()).toBeNull()
  })

  it('does not throw the user out of the trays to answer an intent', async () => {
    /* The hostile-navigation rule, made executable. An intent that landed while the user was
       mid-flow can only change anything by destroying that flow — and there is no route back to
       a populated picker from the library. The agent's save is not worth that. */
    listSavedReelCards.mockResolvedValue([
      cardWithPlaces('r1', 'One-place reel', [placeProof({ place_id: 'p1', name: 'Place 1' })]),
    ])
    renderFlow()
    await screen.findByText('One-place reel')
    createTrail()
    await screen.findByRole('heading', { name: 'Japan' })
    fireEvent.click(screen.getByRole('checkbox', { name: /select Place 1/i }))

    const { settled } = requestViewIntent('saved-reels')
    await waitFor(async () => { expect(await isSettled(settled)).toBe(true) })

    expect(screen.getByRole('heading', { name: 'Japan' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /select Place 1/i })).toBeChecked()
  })

  /* ── Honouring the intent, not merely acknowledging it ───────────────────────────────────────
     Acknowledging released the tool and changed nothing else, which was right for every phase
     except the one people actually save from. Signed in on /app, "save these reels" saved them
     and left the home screen exactly as it was — the user still had to find "Open" themselves,
     and `save_reels` awaits its reveal precisely so that cannot happen.

     `library-reveals` is the seam: the count this page hands the inbox, which the real
     TraysScreen turns into an open Library (TraysScreen.test.tsx). Read here because it is the
     DECISION that was wrong — every unsafe phase must leave it alone. */
  const revealCount = () => Number(screen.getByTestId('library-reveals').textContent)

  it('reveals the library for an intent that lands while the user is already home', async () => {
    renderFlow()
    await loadedInbox()
    expect(revealCount()).toBe(0)

    const { settled } = requestViewIntent('saved-reels')

    await waitFor(() => { expect(revealCount()).toBe(1) })
    expect(await isSettled(settled)).toBe(true)
  })

  it('reveals it on arrival from another route too', async () => {
    // The path that already moved the browser. It must keep working, and now land on the same
    // screen the already-here case does — one destination for one action, not two.
    requestViewIntent('saved-reels')
    renderFlow()
    await loadedInbox()

    await waitFor(() => { expect(revealCount()).toBe(1) })
  })

  it('reveals once per ask, so two saves in a row both land', async () => {
    // A flag could not express this: the user can close the Library between two saves, and the
    // second one has to be able to open it again.
    renderFlow()
    await loadedInbox()
    requestViewIntent('saved-reels')
    await waitFor(() => { expect(revealCount()).toBe(1) })

    requestViewIntent('saved-reels')

    await waitFor(() => { expect(revealCount()).toBe(2) })
  })

  it('leaves the library alone for a generation intent', async () => {
    /* Reason, not merely arrival. `plan_trip_from_reels` asks for this page because the wait
       screen renders here; opening the saved-reel Library underneath it would be a screen the
       user never sees, waiting to surprise them when the run ends. */
    renderFlow()
    await loadedInbox()

    const { settled } = requestViewIntent('trip-generation')
    await waitFor(async () => { expect(await isSettled(settled)).toBe(true) })

    expect(revealCount()).toBe(0)
  })

  it('asks for nothing from the trays — and the walk home proves it', async () => {
    /* The fault-injection direction. A reveal raised mid-picker cannot be "deferred": leaving it
       queued would open the Library the moment the user walked back, minutes later, with no
       action of theirs to explain it. Ignored means dropped. */
    listSavedReelCards.mockResolvedValue([
      cardWithPlaces('r1', 'One-place reel', [placeProof({ place_id: 'p1', name: 'Place 1' })]),
    ])
    renderFlow()
    await screen.findByText('One-place reel')
    createTrail()
    await screen.findByRole('heading', { name: 'Japan' })

    const { settled } = requestViewIntent('saved-reels')
    await waitFor(async () => { expect(await isSettled(settled)).toBe(true) })
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))

    expect(await screen.findByText('One-place reel')).toBeInTheDocument()
    expect(revealCount()).toBe(0)
  })

  it('asks for nothing from the brief either', async () => {
    // A half-filled brief is the most expensive screen to lose in this flow: the dates and
    // preferences typed into it exist nowhere else.
    listSavedReelCards.mockResolvedValue([
      cardWithPlaces('r1', 'One-place reel', [placeProof({ place_id: 'p1', name: 'Place 1' })]),
    ])
    renderFlow()
    await screen.findByText('One-place reel')
    createTrail()
    await screen.findByRole('heading', { name: 'Japan' })
    fireEvent.click(screen.getByRole('checkbox', { name: /select Place 1/i }))
    fireEvent.click(screen.getByRole('button', { name: /plan this trip/i }))
    await screen.findByRole('button', { name: /generate/i })

    const { settled } = requestViewIntent('saved-reels')
    await waitFor(async () => { expect(await isSettled(settled)).toBe(true) })

    expect(screen.getByRole('button', { name: /generate/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /back to places/i }))
    fireEvent.click(await screen.findByRole('button', { name: /^back$/i }))
    expect(await screen.findByText('One-place reel')).toBeInTheDocument()
    expect(revealCount()).toBe(0)
  })

  it('asks for nothing while a run is on the wait screen', async () => {
    /* The case the phase alone cannot see. An AGENT-started run leaves `phase` at 'inbox' the
       whole time it is building, so a check on the phase would honour a save raised mid-run and
       open the Library behind GenerationScene — invisible until the run ended, then on screen
       for no reason the user could name. */
    renderFlow()
    await loadedInbox()
    await act(async () => { shellApi!.reserve()!.begin('trip-agent') })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await waitFor(() => expect(streamGeneration).toHaveBeenCalled())
    await screen.findByTestId('generation-progress')

    const { settled } = requestViewIntent('saved-reels')
    await waitFor(async () => { expect(await isSettled(settled)).toBe(true) })
    expect(screen.getByTestId('generation-progress')).toBeInTheDocument()

    // The run dies, handing the inbox back — the count it comes back to must still be nothing.
    await act(async () => { emitToRun!({ type: 'result', content: JSON.stringify({ error: 'lease lost' }) }); await Promise.resolve() })

    expect(await screen.findByText('Tokyo Tower at sunset')).toBeInTheDocument()
    expect(revealCount()).toBe(0)
  })

  /* The shell outlives the page, exactly as /app/layout.tsx does: the run is started while the
     user is somewhere else, and this component mounts into it when the route change lands. */
  function Shell({ here }: { here: boolean }) {
    return (
      <MapProvider>
        <GenerationProvider>
          <ShellProbe />
          {here ? <SavedReelsFlow /> : <p>a different route</p>}
        </GenerationProvider>
      </MapProvider>
    )
  }

  it('shows the wait screen on a FRESH mount, for a run started from another route', async () => {
    // GenerationScene renders only inside this component, so a run started from /app/settings had
    // nothing on screen at all. Arriving has to BE the takeover, not something a later event does.
    const view = render(<Shell here={false} />)
    await act(async () => { shellApi!.reserve()!.begin('trip-agent') })
    await waitFor(() => expect(streamGeneration).toHaveBeenCalled())

    view.rerender(<Shell here />)

    expect(await screen.findByTestId('generation-progress')).toBeInTheDocument()
  })

  /* The HAND-OVER. Reported twice from live runs: "it will go back the home page then only show
     me the generated trip."

     `router.push` is not the frame that replaces this page. The status flip to 'complete' commits
     immediately; Next then fetches the trip route over many frames, with /app still on screen. A
     wait screen keyed on 'generating' alone therefore stopped rendering while this component was
     still mounted, and the library underneath painted in the gap. The page's OWN generation hid
     it — `phase` stays 'generating' on a success — so only a run this page did not start bounced,
     which is every agent-started run and every run the user navigates back into. */
  it('holds the wait screen through the hand-off — the library must not flash in between', async () => {
    const view = render(<Shell here={false} />)
    await act(async () => { shellApi!.reserve()!.begin('trip-agent') })
    await waitFor(() => expect(streamGeneration).toHaveBeenCalled())
    view.rerender(<Shell here />)
    await screen.findByTestId('generation-progress')

    await act(async () => { emitToRun!({ type: 'result', content: JSON.stringify({ trip_id: 'trip-agent' }) }); await Promise.resolve() })

    expect(push).toHaveBeenCalledWith('/app/trip/trip-agent')
    // The route has NOT moved yet — this is exactly the gap the user was seeing.
    expect(screen.getByTestId('generation-progress')).toBeInTheDocument()
    expect(screen.queryByText('Tokyo Tower at sunset')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'mock-plan-trip' })).not.toBeInTheDocument()
  })

  it('gives the library back on a FRESH mount after the hand-off', async () => {
    /* The other half of the hold: `run.status` never returns to idle, so a hold keyed on
       'complete' alone would put the wait screen back for good the moment the user pressed Back
       from the finished trip — a dead end with no route out. The hold belongs to the mount that
       watched the run build, and to no other. */
    const view = render(<Shell here={false} />)
    await act(async () => { shellApi!.reserve()!.begin('trip-agent') })
    await waitFor(() => expect(streamGeneration).toHaveBeenCalled())
    view.rerender(<Shell here />)
    await screen.findByTestId('generation-progress')
    await act(async () => { emitToRun!({ type: 'result', content: JSON.stringify({ trip_id: 'trip-agent' }) }); await Promise.resolve() })
    expect(screen.getByTestId('generation-progress')).toBeInTheDocument()

    // The trip page opens, then the user comes back: this component is mounted afresh.
    view.rerender(<Shell here={false} />)
    view.rerender(<Shell here />)

    expect(await screen.findByText('Tokyo Tower at sunset')).toBeInTheDocument()
    expect(screen.queryByTestId('generation-progress')).not.toBeInTheDocument()
  })

  it('does not strand a failed NEW generation on the finished run’s wait screen', async () => {
    /* The hold is latched while the run is GENERATING here, not merely while the wait screen is
       up. `phase` goes to 'generating' before the POST and back to 'brief' when it throws — and
       the previous run's 'complete' is still the current status throughout. A latch taken on the
       wait screen being up would fire there, and the user whose new trip never started would be
       parked on the wait screen of a trip that is already open. */
    listSavedReelCards.mockResolvedValue([cardWithPlaces('r1', 'One-place reel', [placeProof({ place_id: 'p1', name: 'Place 1' })])])
    const view = render(<Shell here={false} />)
    await act(async () => { shellApi!.reserve()!.begin('trip-agent') })
    await waitFor(() => expect(streamGeneration).toHaveBeenCalled())
    view.rerender(<Shell here />)
    await screen.findByTestId('generation-progress')
    await act(async () => { emitToRun!({ type: 'result', content: JSON.stringify({ trip_id: 'trip-agent' }) }); await Promise.resolve() })
    // Trip opened; the user returns to the library and builds another.
    view.rerender(<Shell here={false} />)
    view.rerender(<Shell here />)
    await screen.findByText('One-place reel')

    generateTrip.mockReset()
    generateTrip.mockRejectedValueOnce(new Error('Could not reach the planner.'))
    createTrail()
    await screen.findByRole('heading', { name: 'Japan' })
    fireEvent.click(screen.getByRole('checkbox', { name: /select Place 1/i }))
    fireEvent.click(screen.getByRole('button', { name: /plan this trip/i }))
    await screen.findByRole('heading', { name: /plan this trip/i })
    pickTripDates()
    fireEvent.click(await screen.findByRole('button', { name: /generate trip/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the planner.')
    expect(screen.getByRole('button', { name: /generate trip/i })).toBeInTheDocument()
    expect(screen.queryByTestId('generation-progress')).not.toBeInTheDocument()
  })

  it('still hands the page back when a run that arrived this way ends badly', async () => {
    /* The exit path, from the one mount that never had a 'generating' phase of its own. The shell
       navigates on SUCCESS only, so without this the wait screen is where the session ends. */
    const view = render(<Shell here={false} />)
    await act(async () => { shellApi!.reserve()!.begin('trip-agent') })
    await waitFor(() => expect(streamGeneration).toHaveBeenCalled())
    view.rerender(<Shell here />)
    await screen.findByTestId('generation-progress')

    await act(async () => { emitToRun!({ type: 'result', content: JSON.stringify({ error: 'lease lost' }) }); await Promise.resolve() })

    expect(await screen.findByText('Tokyo Tower at sunset')).toBeInTheDocument()
    expect(await screen.findByText(/could not be finished/i)).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })
})
