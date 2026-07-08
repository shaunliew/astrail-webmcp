'use client'

import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function SignOutButton() {
  const router = useRouter()
  async function signOut() {
    await createClient().auth.signOut()
    router.push('/sign-in')
  }
  return (
    <button
      type="button"
      onClick={() => void signOut()}
      className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)] underline-offset-2 hover:underline"
    >
      Sign out
    </button>
  )
}
