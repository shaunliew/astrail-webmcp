import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { push, getAccessToken, listSavedReelCards, startOrganize, streamOrganize, getOrganizeStatus, generateTrip, streamGeneration } = vi.hoisted(() => ({
  push: vi.fn(),
  getAccessToken: vi.fn(async () => 'token'),
  listSavedReelCards: vi.fn(),
  startOrganize: vi.fn(),
  streamOrganize: vi.fn(),
  getOrganizeStatus: vi.fn(),
  generateTrip: vi.fn(async () => ({ trip_id: 'trip-1' })),
  streamGeneration: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('next/link', () => ({ default: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a> }))
vi.mock('@/lib/supabase/session', () => ({ getAccessToken }))
vi.mock('@/lib/reels/api', () => ({ listSavedReelCards, startOrganize, streamOrganize, getOrganizeStatus }))
vi.mock('@/lib/trip/api', () => ({ generateTrip, streamGeneration }))

import SavedReelsFlow, { toReelBriefItem } from '@/components/reels/SavedReelsFlow'
import type { SavedReelCard } from '@/lib/reels/backend-types'

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

async function startSelectedOrganize() {
  const rendered = render(<SavedReelsFlow />)
  await screen.findByText(/cache ready/i)
  fireEvent.click(screen.getByRole('button', { name: /select reels/i }))
  fireEvent.click(screen.getByRole('checkbox', { name: /select .*AAA/i }))
  fireEvent.click(screen.getByRole('button', { name: /organize selected/i }))
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
  })

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

  it('shows cached and uncached cards, then enters temporary selection mode with quota copy', async () => {
    render(<SavedReelsFlow />)
    expect(await screen.findByText(/cache ready/i)).toBeInTheDocument()
    expect(screen.getByText(/not analyzed yet/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /select reels/i }))
    expect(screen.getByText(/0 \/ 5 selected/i)).toBeInTheDocument()
    expect(screen.getByText(/cached reels are free/i)).toBeInTheDocument()
  })

  it('organizes selected Reels, shows the replacing globe status, and opens country trays', async () => {
    render(<SavedReelsFlow />)
    await screen.findByText(/cache ready/i)
    fireEvent.click(screen.getByRole('button', { name: /select reels/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /select .*AAA/i }))
    fireEvent.click(screen.getByRole('button', { name: /organize selected/i }))
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
    render(<SavedReelsFlow />)
    await screen.findByText(/cache ready/i)
    fireEvent.click(screen.getByRole('button', { name: /select reels/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /select .*AAA/i }))
    fireEvent.click(screen.getByRole('button', { name: /organize selected/i }))
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
    render(<SavedReelsFlow />)
    await screen.findByText(/cache ready/i)
    fireEvent.click(screen.getByRole('button', { name: /select reels/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /select .*AAA/i }))
    fireEvent.click(screen.getByRole('button', { name: /organize selected/i }))
    listSavedReelCards.mockResolvedValueOnce(organizedCards)
    await screen.findByTestId('organize-globe')
    await waitFor(() => expect(streamOrganize).toHaveBeenCalledTimes(1))
    const onEvent = streamOrganize.mock.calls[0][2] as (event: unknown) => void
    onEvent({ type: 'result', content: JSON.stringify({ status: 'succeeded' }) })
    await screen.findByRole('heading', { name: 'Japan' })
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /select Tokyo Tower/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('checkbox', { name: /select Tokyo Tower/i }))
    fireEvent.click(screen.getByRole('button', { name: /plan this trip/i }))
    fireEvent.change(screen.getByLabelText(/start date/i), { target: { value: '2026-08-01' } })
    fireEvent.change(screen.getByLabelText(/end date/i), { target: { value: '2026-08-04' } })
    fireEvent.click(screen.getByRole('button', { name: /review trip brief/i }))

    expect(screen.getByText('Reels (1)')).toBeInTheDocument()
    expect(screen.getByText(cards[0].normalized_url)).toBeInTheDocument()
    expect(screen.getByText('Requested places (0)')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: /generate my trip/i }))

    await waitFor(() => expect(generateTrip).toHaveBeenCalledWith(
      expect.objectContaining({ place_ids: ['place-1'], reel_urls: [], requested_places: [] }),
      'token',
    ))
    expect(streamGeneration).toHaveBeenCalled()
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/trip/trip-1'))
  })

  it('returns a failed provider job to the inbox with a persistent retry message', async () => {
    getOrganizeStatus.mockResolvedValueOnce({
      job_id: 'job-1', status: 'failed', status_message: 'Location verification provider unavailable. Try again.',
      total_items: 1, processed_items: 1, organized_items: 0, location_not_found_items: 0, failed_items: 1,
      items: [{ saved_reel_id: 'saved-1', status: 'failed', place_count: 0, error_message: 'provider unavailable' }],
    })

    render(<SavedReelsFlow />)
    await screen.findByText(/cache ready/i)
    fireEvent.click(screen.getByRole('button', { name: /select reels/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /select .*AAA/i }))
    fireEvent.click(screen.getByRole('button', { name: /organize selected/i }))
    await screen.findByTestId('organize-globe')
    await waitFor(() => expect(streamOrganize).toHaveBeenCalledTimes(1))
    const onEvent = streamOrganize.mock.calls[0][2] as (event: unknown) => void
    onEvent({ type: 'result', content: JSON.stringify({ status: 'failed' }) })

    expect(await screen.findByRole('alert')).toHaveTextContent('Location verification provider unavailable. Try again.')
    fireEvent.click(screen.getByRole('button', { name: /select reels/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /select .*AAA/i }))
    fireEvent.click(screen.getByRole('button', { name: /organize selected/i }))
    await waitFor(() => expect(startOrganize).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('returns a zero-verified-place result to the inbox without opening an empty tray', async () => {
    getOrganizeStatus.mockResolvedValueOnce({
      job_id: 'job-1', status: 'succeeded', status_message: 'Organized',
      total_items: 1, processed_items: 1, organized_items: 0, location_not_found_items: 1, failed_items: 0,
      items: [{ saved_reel_id: 'saved-1', status: 'location_not_found', place_count: 0, error_message: null }],
    })

    render(<SavedReelsFlow />)
    await screen.findByText(/cache ready/i)
    fireEvent.click(screen.getByRole('button', { name: /select reels/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /select .*AAA/i }))
    fireEvent.click(screen.getByRole('button', { name: /organize selected/i }))
    await screen.findByTestId('organize-globe')
    await waitFor(() => expect(streamOrganize).toHaveBeenCalledTimes(1))
    const onEvent = streamOrganize.mock.calls[0][2] as (event: unknown) => void
    onEvent({ type: 'result', content: JSON.stringify({ status: 'succeeded' }) })

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not verify any locations/i)
    expect(screen.queryByRole('button', { name: /plan this trip/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /select reels/i })).toBeInTheDocument()
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
    const { unmount } = render(<SavedReelsFlow />)
    unmount()
    resolveCards(cards)
    await Promise.resolve(); await Promise.resolve()
    expect(screen.queryByText(/cache ready/i)).not.toBeInTheDocument()
    expect(streamOrganize).not.toHaveBeenCalled()
  })
})
