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
    expect(query.select).toHaveBeenCalledWith(expect.stringContaining('has_current_cache'))
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

  it('maps an active organize overlap to a friendly inbox message', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('', { status: 409 }))

    await expect(startOrganize(['saved-1'], 'jwt-token')).rejects.toThrow(
      'One of those Reels is already being organized. Wait for it to finish, or deselect it and organize the others.',
    )
  })

  it('maps a capture 422 envelope to the friendly capture validation copy', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'validation_error', message: 'not a valid url' } }), { status: 422 }),
    )

    await expect(captureSavedReel('not-a-url', 'jwt-token')).rejects.toThrow(
      "That doesn't look like an Instagram link we can save. Paste a Reel or post URL like instagram.com/reel/… or instagram.com/p/…",
    )
  })

  it('maps a capture 429 envelope to the capture-scoped rate copy', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }), { status: 429 }),
    )

    await expect(captureSavedReel('https://www.instagram.com/reel/AAA/', 'jwt-token')).rejects.toThrow(
      "You're saving fast — give it a few seconds and try again.",
    )
  })

  it('maps an organize 429 envelope to the GENERIC rate copy, not the capture copy (Codex P2)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }), { status: 429 }),
    )

    const error = (await startOrganize(['saved-1'], 'jwt-token').catch((e) => e)) as Error
    expect(error.message).toBe('Too many requests — give it a few seconds and try again.')
    expect(error.message).not.toContain("You're saving fast")
  })

  it('falls back through STATUS_TO_CODE when a 429 body is not the JSON envelope (proxy/CDN HTML)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('<html><body>429 Too Many Requests</body></html>', {
        status: 429,
        headers: { 'Content-Type': 'text/html' },
      }),
    )

    await expect(startOrganize(['saved-1'], 'jwt-token')).rejects.toThrow(
      'Too many requests — give it a few seconds and try again.',
    )
  })

  it('falls back to the generic error copy for an unknown status with a non-JSON body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('upstream boom', { status: 500 }))

    await expect(captureSavedReel('https://www.instagram.com/reel/AAA/', 'jwt-token')).rejects.toThrow(
      'Something went wrong on our side. Try again in a moment.',
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
