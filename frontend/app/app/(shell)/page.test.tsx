import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

process.env.NEXT_PUBLIC_MOCK_AUTH = 'true'

const { createClient, fetchMock, eventSource, push } = vi.hoisted(() => ({
  createClient: vi.fn(),
  fetchMock: vi.fn(),
  eventSource: vi.fn(),
  push: vi.fn(),
}))

vi.mock('@/components/reels/SavedReelsFlow', () => ({
  default: () => <div data-testid="saved-reels-flow" />,
}))
vi.mock('@/lib/supabase/client', () => ({ createClient }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('next/link', () => ({
  default: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
}))

describe('/app mock-auth gate', () => {
  beforeEach(() => {
    createClient.mockReset()
    fetchMock.mockReset()
    eventSource.mockReset()
    push.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('EventSource', eventSource)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders the offline CreateTripFlow without Saved Reels or backend calls', async () => {
    vi.resetModules()
    process.env.NEXT_PUBLIC_MOCK_AUTH = 'true'
    const { default: AppHomePage } = await import('@/app/app/(shell)/page')
    // Same module registry as the page: resetModules gives MapProvider a fresh context
    // object, and a statically imported one would not match what the page consumes.
    const { default: MapProvider } = await import('@/components/map/MapProvider')
    render(<MapProvider><AppHomePage /></MapProvider>)
    // CreateTripFlow now mounts useEntitlement(), whose read effect resolves on a microtask
    // (a mock-mode entitlement + listTrips, no network — asserted below). Flush it inside act()
    // so its state update is wrapped, not a stray post-assertion "not wrapped in act(...)" warning.
    await act(async () => {})

    expect(screen.getByRole('heading', { name: 'Plan a new trip' })).toBeInTheDocument()
    expect(screen.queryByTestId('saved-reels-flow')).not.toBeInTheDocument()
    expect(createClient).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(eventSource).not.toHaveBeenCalled()
  })
})
