import { beforeEach, describe, expect, it, vi } from 'vitest'

const { from, getSession, createClient } = vi.hoisted(() => ({
  from: vi.fn(),
  getSession: vi.fn(),
  createClient: vi.fn(() => ({ auth: { getSession }, from })),
}))

vi.mock('@/lib/supabase/client', () => ({ createClient }))

import { captureSavedReel, listSavedReelCards, startOrganize, streamOrganize } from '@/lib/reels/api'

describe('saved reels api', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    from.mockReset()
    getSession.mockReset()
    getSession.mockResolvedValue({ data: { session: { access_token: 'jwt-token' } }, error: null })
    vi.stubGlobal('fetch', vi.fn())
  })

  it('captures through the authenticated backend route', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ saved_reel: { id: 'saved-1' } }), { status: 200 }))

    await captureSavedReel('https://www.instagram.com/reel/ABC/', 'jwt-token')

    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/saved-reels$/),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer jwt-token' }),
        body: JSON.stringify({ url: 'https://www.instagram.com/reel/ABC/' }),
      }),
    )
  })

  it('reads only the safe saved_reel_cards projection', async () => {
    const query = { select: vi.fn(), order: vi.fn() }
    query.select.mockReturnValue(query)
    query.order.mockResolvedValue({ data: [{ id: 'saved-1', caption: 'safe caption', places: [] }], error: null })
    from.mockReturnValue(query)

    await listSavedReelCards()

    expect(getSession).toHaveBeenCalledTimes(1)
    expect(from).toHaveBeenCalledWith('saved_reel_cards')
    expect(query.select).toHaveBeenCalledWith(expect.stringContaining('caption'))
    expect(query.select.mock.calls[0][0]).not.toContain('raw_payload')
    expect(query.select.mock.calls[0][0]).not.toContain('transcript')
  })

  it('does not query the protected cards view before auth hydration completes', async () => {
    getSession.mockResolvedValueOnce({ data: { session: null }, error: null })

    await expect(listSavedReelCards()).rejects.toThrow('not signed in')

    expect(from).not.toHaveBeenCalled()
  })

  it('starts organize with only the selected Saved Reel ids', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ job_id: 'job-1' }), { status: 200 }))

    await startOrganize(['saved-1', 'saved-2'], 'jwt-token')

    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/saved-reels\/organize$/),
      expect.objectContaining({ body: JSON.stringify({ saved_reel_ids: ['saved-1', 'saved-2'] }) }),
    )
  })

  it('reconnects the durable event stream from the last cursor', () => {
    vi.useFakeTimers()
    class FakeEventSource {
      static instances: FakeEventSource[] = []
      onopen: (() => void) | null = null
      onerror: (() => void) | null = null
      onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null
      url: string
      constructor(url: string) { this.url = url; FakeEventSource.instances.push(this) }
      close = vi.fn()
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    const handle = streamOrganize('job-1', 'token', vi.fn())
    FakeEventSource.instances[0].onmessage?.({ data: JSON.stringify({ type: 'stage', stage: 'processing', msg: 'working' }), lastEventId: 'event-42' })
    FakeEventSource.instances[0].onerror?.()
    vi.advanceTimersByTime(250)

    expect(FakeEventSource.instances[1].url).toContain('cursor=event-42')
    handle.cancel()
    vi.useRealTimers()
  })
})
