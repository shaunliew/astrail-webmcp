import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { MOCK_AUTH_ENABLED } from '@/lib/auth/mock-auth'

export async function middleware(request: NextRequest) {
  // Mock-auth bypass: let the hardcoded shell run with zero backend.
  if (MOCK_AUTH_ENABLED) {
    return NextResponse.next({ request })
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // Public sample trip: rendered from a fixture, so there is no DB row and no user data to leak.
  // Allowlisted ahead of BOTH gates below — the signed-out redirect and the onboarding bounce —
  // so it opens for a visitor with no account and for a signed-in user mid-onboarding alike.
  // EXACT match, never a prefix: `startsWith` here would expose /app/trip/<any-uuid>.
  if (request.nextUrl.pathname === '/app/trip/demo') {
    return supabaseResponse
  }

  if (!user && request.nextUrl.pathname.startsWith('/app')) {
    const url = request.nextUrl.clone()
    url.pathname = '/sign-in'
    return NextResponse.redirect(url)
  }

  // Onboarding gate: authenticated users must finish the wizard once before /app/*.
  // Missing profile row counts as not onboarded (no auto-create trigger for traveler_profiles).
  if (user && !request.nextUrl.pathname.startsWith('/app/onboarding')) {
    const { data: profile } = await supabase
      .from('traveler_profiles')
      .select('onboarding_completed')
      .eq('id', user.id)
      .maybeSingle()
    if (!profile?.onboarding_completed) {
      const url = request.nextUrl.clone()
      url.pathname = '/app/onboarding'
      return NextResponse.redirect(url)
    }
  }

  return supabaseResponse
}

export const config = {
  matcher: ['/app/:path*'],
}
