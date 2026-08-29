// middleware.test.ts
//
// middleware.ts is the gate on EVERY authenticated route in the product (matcher: /app/:path*),
// so the only change it should ever carry is one whose blast radius is provable. `/app/trip/demo`
// renders a fixture — no DB row, no user data — and is allowlisted so a judge with no account can
// open it. These tests exist to prove the allowlist is an EXACT match and that nothing else leaked:
// `/app/trip/<uuid>`, `/app/trip/demo/extra` and `/app/trip/demoX` must all still redirect. Swap
// the `===` for `startsWith` and the last two go red — that is the point of them.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { createServerClient } = vi.hoisted(() => ({ createServerClient: vi.fn() }))
vi.mock('@supabase/ssr', () => ({ createServerClient }))
// The demo shell short-circuits the whole middleware before any gate. Pin it off so these tests
// exercise the real gates regardless of what NEXT_PUBLIC_MOCK_AUTH holds in .env / .env.local.
vi.mock('@/lib/auth/mock-auth', () => ({
  MOCK_AUTH_ENABLED: false,
  MOCK_USER: {},
  getMockSession: () => null,
}))

import { NextRequest } from 'next/server'
import { middleware } from '@/middleware'

// NextResponse.next({ request }) asserts `request.headers instanceof Headers`. This suite runs in
// the project-default jsdom environment, where globalThis.Headers is jsdom's class while
// NextRequest builds its headers from Node's undici one — two different constructors, so the check
// throws for reasons that have nothing to do with the middleware. (Switching this file to the node
// environment is the tidier fix, but vitest.setup.ts dereferences `Element` at load and that does
// not exist under node. Note the env docblock is matched anywhere in the file, not just the header,
// so do not write its literal name in a comment here.) Point the global at the class NextRequest
// actually uses.
vi.stubGlobal('Headers', new NextRequest(new URL('https://astrail.app/')).headers.constructor)

type User = { id: string } | null
type Profile = { onboarding_completed: boolean } | null

/** Installs a fake Supabase client. Returns the tables `.from()` was called on, so a test can
 *  assert the onboarding lookup was SKIPPED rather than merely that its answer was ignored. */
function stubSupabase(user: User, profile: Profile): { fromCalls: string[] } {
  const fromCalls: string[] = []
  createServerClient.mockImplementation(() => ({
    auth: { getUser: async () => ({ data: { user } }) },
    from: (table: string) => {
      fromCalls.push(table)
      // Fluent PostgREST builder: every method returns the builder, maybeSingle resolves.
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: profile, error: null }),
      }
      return builder
    },
  }))
  return { fromCalls }
}

const request = (pathname: string) => new NextRequest(new URL(pathname, 'https://astrail.app'))

/** NextResponse.next() carries no Location header; a redirect does. */
const redirectedTo = (res: Response): string | null => {
  const location = res.headers.get('location')
  return location === null ? null : new URL(location).pathname
}

beforeEach(() => {
  createServerClient.mockReset()
})

describe('middleware — signed out', () => {
  it('lets /app/trip/demo through without a redirect', async () => {
    stubSupabase(null, null)
    const res = await middleware(request('/app/trip/demo'))
    expect(redirectedTo(res)).toBeNull()
    expect(res.status).toBe(200)
  })

  it.each([
    ['/app'],
    ['/app/trips'],
    ['/app/settings'],
    // A real-looking trip id. This is the case that proves the match is exact and not a prefix on
    // /app/trip/ — a sloppy pattern here would expose every other user's trip page.
    ['/app/trip/9f2c1d3e-4b5a-6c7d-8e9f-0a1b2c3d4e5f'],
    ['/app/trip/demo/extra'],
    ['/app/trip/demoX'],
  ])('still redirects %s to /sign-in', async (pathname) => {
    stubSupabase(null, null)
    const res = await middleware(request(pathname))
    expect(redirectedTo(res)).toBe('/sign-in')
  })
})

describe('middleware — signed in, onboarding not completed', () => {
  it('lets /app/trip/demo through, and does not even look up the profile', async () => {
    const { fromCalls } = stubSupabase({ id: 'user-1' }, { onboarding_completed: false })
    const res = await middleware(request('/app/trip/demo'))
    expect(redirectedTo(res)).toBeNull()
    expect(res.status).toBe(200)
    expect(fromCalls).not.toContain('traveler_profiles')
  })

  it('still bounces /app to /app/onboarding', async () => {
    stubSupabase({ id: 'user-1' }, { onboarding_completed: false })
    const res = await middleware(request('/app'))
    expect(redirectedTo(res)).toBe('/app/onboarding')
  })

  it('still bounces /app when the profile row is missing entirely', async () => {
    stubSupabase({ id: 'user-1' }, null)
    const res = await middleware(request('/app'))
    expect(redirectedTo(res)).toBe('/app/onboarding')
  })
})
