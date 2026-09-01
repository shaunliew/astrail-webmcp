import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import RememberedPreferences, { __resetRememberedPreferencesCache } from '../RememberedPreferences'

const { getMemoryPreferences } = vi.hoisted(() => ({ getMemoryPreferences: vi.fn() }))
vi.mock('@/lib/trip/supabase-api', () => ({ getMemoryPreferences }))

const fact = (memory: string, id = memory) => ({ id, memory, created_at: '2026-01-01T00:00:00Z', source: 'mem0' as const })

afterEach(() => {
  cleanup()
  getMemoryPreferences.mockReset()
  // Module state outlives cleanup(); without this a case inherits the previous one's read.
  __resetRememberedPreferencesCache()
})

/**
 * What Astrail holds about you, said on the screen you start from.
 *
 * The agent acts on remembered preferences the user never stated in this session, and until now
 * the only place to see them was Settings. So a person watching Astrail plan — and anyone watching
 * over their shoulder — had no way to know what context it was acting on.
 *
 * The silence is the load-bearing half. A first-time account has nothing remembered and nothing to
 * act on, so anything rendered there is noise on the one screen that has to stay clean: an empty
 * account is what the demo opens on, and "memory unavailable" is a status a user cannot do
 * anything about. Settings owns the disabled and unavailable states, and already states them.
 */
describe('RememberedPreferences', () => {
  it('says what Astrail remembers when it remembers something', async () => {
    getMemoryPreferences.mockResolvedValue({ status: 'ok', facts: [fact('Prefers walkable days'), fact('Loves ramen')] })
    render(<RememberedPreferences />)
    expect(await screen.findByText(/Prefers walkable days · Loves ramen/)).toBeInTheDocument()
    // The same provenance word Settings and the evidence chips use, so a reader knows this line
    // is remembered rather than something they typed for this session.
    expect(screen.getByText('Memory')).toBeInTheDocument()
  })

  /* The two off states carry a fact deliberately. `status` and `facts` answer different
     questions and the backend keeps them apart for that reason — an empty list under a non-ok
     status is a failed read, not an honest empty. Giving these cases an empty list would have
     let them pass with no status check in the code at all. */
  const silent: [string, unknown][] = [
    ['nothing remembered yet', { status: 'ok', facts: [] }],
    ['memory switched off for the account', { status: 'disabled', facts: [fact('Prefers walkable days')] }],
    ['the memory service is down', { status: 'unavailable', facts: [fact('Prefers walkable days')] }],
    ['a payload that is not the shape it promised', { status: 'ok', facts: null }],
  ]

  it.each(silent)('renders nothing when there is %s', async (_label, response) => {
    getMemoryPreferences.mockResolvedValue(response)
    const { container } = render(<RememberedPreferences />)
    await waitFor(() => expect(getMemoryPreferences).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the read rejects outright', async () => {
    /* `getMemoryPreferences` maps its own failures to `unavailable`, but it builds the Supabase
       client before its try block, so a missing key rejects. A home page that throws because it
       could not read a decoration is worse than one that says nothing. */
    getMemoryPreferences.mockRejectedValue(new Error('no supabase env'))
    const { container } = render(<RememberedPreferences />)
    await waitFor(() => expect(getMemoryPreferences).toHaveBeenCalled())
    expect(container).toBeEmptyDOMElement()
  })

  /* One read per half-minute, not one per mount. `GET /settings/preferences` is rate-limited at
     three a minute, this component remounts on every phase change of the screen it lives on, and
     `plan_trip_from_reels` spends one of the same allowance on its own memory check. Without the
     cache, home → trays → home → plan is four requests and the fourth 429s — which the tool
     treats as unknown and plans through, silently dropping the disclosure from the approval card. */
  it('does not re-read the endpoint on every remount', async () => {
    getMemoryPreferences.mockResolvedValue({ status: 'ok', facts: [fact('Prefers walkable days')] })
    const first = render(<RememberedPreferences />)
    expect(await screen.findByText(/Prefers walkable days/)).toBeInTheDocument()
    first.unmount()

    render(<RememberedPreferences />)
    expect(await screen.findByText(/Prefers walkable days/)).toBeInTheDocument()
    expect(getMemoryPreferences, 'a phase flip spent another request').toHaveBeenCalledTimes(1)
  })

  it('does not cache a failed read, so an outage does not outlive itself', async () => {
    // Caching silence would hold it past the outage that caused it — the line would stay missing
    // for a user whose memory is fine, until they hard-reloaded.
    getMemoryPreferences.mockResolvedValue({ status: 'unavailable', facts: [] })
    const first = render(<RememberedPreferences />)
    await waitFor(() => expect(getMemoryPreferences).toHaveBeenCalledTimes(1))
    first.unmount()

    getMemoryPreferences.mockResolvedValue({ status: 'ok', facts: [fact('Loves ramen')] })
    render(<RememberedPreferences />)
    expect(await screen.findByText(/Loves ramen/)).toBeInTheDocument()
  })
})
