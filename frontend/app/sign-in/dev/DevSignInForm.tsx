'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

/* Deliberately plain and loudly labeled: this form exists only in development (the
   server component gates on NODE_ENV) and shows raw Supabase errors — it's a tool,
   not a product surface. */
export default function DevSignInForm() {
  const router = useRouter()
  const [email, setEmail] = useState('aster@astrail.app')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function signIn(e: React.FormEvent) {
    e.preventDefault()
    setPending(true)
    setError(null)
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    setPending(false)
    if (error) {
      setError(error.message)
      return
    }
    router.push('/app')
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0b0f16] p-6">
      <form onSubmit={signIn} className="flex w-full max-w-sm flex-col gap-3">
        <h1 className="font-mono text-sm uppercase tracking-[0.2em] text-[#EFC98D]">
          Dev sign-in
        </h1>
        <p className="font-mono text-xs text-[#8a8f98]">
          Development only — password auth for seeded demo accounts.
        </p>
        <label className="font-mono text-xs text-[#8a8f98]">
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            className="mt-1 w-full rounded border border-[#2a2f38] bg-[#11151c] p-2 font-mono text-sm text-[#F2ECE0]"
          />
        </label>
        <label className="font-mono text-xs text-[#8a8f98]">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="mt-1 w-full rounded border border-[#2a2f38] bg-[#11151c] p-2 font-mono text-sm text-[#F2ECE0]"
          />
        </label>
        {error ? <p className="font-mono text-xs text-[#e5484d]">{error}</p> : null}
        <button
          type="submit"
          disabled={pending || password.length === 0}
          className="mt-1 rounded bg-[#EFC98D] p-2 font-mono text-sm font-bold text-[#0b0f16] disabled:opacity-50"
        >
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
