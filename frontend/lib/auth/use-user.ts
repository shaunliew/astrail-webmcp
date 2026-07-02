'use client'

import { useEffect, useState } from 'react'
import { MOCK_AUTH_ENABLED, MOCK_USER } from '@/lib/auth/mock-auth'
import { createClient } from '@/lib/supabase/client'

type AppUser = { id: string; name: string; email: string }

export function useUser(): { user: AppUser | null; loading: boolean } {
  const [user, setUser] = useState<AppUser | null>(MOCK_AUTH_ENABLED ? MOCK_USER : null)
  const [loading, setLoading] = useState(!MOCK_AUTH_ENABLED)

  useEffect(() => {
    if (MOCK_AUTH_ENABLED) return
    let active = true
    const supabase = createClient()
    supabase.auth.getUser().then(({ data }) => {
      if (!active) return
      setUser(
        data.user
          ? {
              id: data.user.id,
              name:
                (data.user.user_metadata?.full_name as string | undefined) ??
                (data.user.email ?? 'Traveler'),
              email: data.user.email ?? '',
            }
          : null,
      )
      setLoading(false)
    })
    return () => { active = false }
  }, [])

  return { user, loading }
}
