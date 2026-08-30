/* The sample trail is the route a judge opens with no account — README and SUBMISSION both send
   people to /app/trip/demo — and until now nothing in the running app linked to it. It lives in
   the persistent rail rather than on a page, so it is reachable from every /app route. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import Sidebar from '@/components/dashboard/Sidebar'

const path = { value: '/app' }

vi.mock('next/navigation', () => ({
  usePathname: () => path.value,
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: null } }), signOut: async () => {} },
  }),
}))
vi.mock('@/lib/trip/supabase-api', () => ({ listTrips: async () => [] }))
vi.mock('@/lib/entitlement', async (orig) => ({
  ...(await orig<typeof import('@/lib/entitlement')>()),
  readEntitlement: async () => {
    throw new Error('not under test')
  },
}))

async function show(pathname: string) {
  path.value = pathname
  render(<Sidebar />)
  // The rail fires three fetches on mount; settle them so no state lands outside act().
  await waitFor(() => expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument())
}

const current = (name: string) => screen.getByRole('link', { name }).getAttribute('aria-current')

beforeEach(() => {
  path.value = '/app'
})

describe('Sidebar sample-trail link', () => {
  it('offers the sample trail from every /app route', async () => {
    await show('/app')
    expect(screen.getByRole('link', { name: 'Sample trail' })).toHaveAttribute(
      'href',
      '/app/trip/demo',
    )
  })

  it('marks itself current on /app/trip/demo', async () => {
    await show('/app/trip/demo')
    expect(current('Sample trail')).toBe('page')
  })

  it('does not light up Trails on the sample trail', async () => {
    /* /app/trip/demo is NOT under /app/trips, so the shared `startsWith` match must not claim it
       — two highlighted rows would tell the user they are somewhere they are not. */
    await show('/app/trip/demo')
    expect(current('Trails')).toBeNull()
    expect(current('Home')).toBeNull()
  })

  it('does not light up on the trails list', async () => {
    await show('/app/trips')
    expect(current('Sample trail')).toBeNull()
    expect(current('Trails')).toBe('page')
  })
})
