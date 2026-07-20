'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import DottedGlobe from '@/components/night/DottedGlobe'

const RESEND_COOLDOWN_S = 60 // Supabase rate-limits OTP sends (~1/min) — surface it, don't let users hit the raw error

export default function SignInPage() {
  const router = useRouter()
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(0)
  const codeRef = useRef<HTMLInputElement>(null)

  // Resend cooldown ticker
  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  async function sendCode() {
    setPending(true); setError(null); setNotice(null)
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: true }, // signup and sign-in are the same flow
    })
    setPending(false)
    if (error) { setError(error.message); return }
    setStep('code')
    setCooldown(RESEND_COOLDOWN_S)
    setNotice(`We sent a 6-digit code to ${email.trim()}.`)
  }

  async function verifyCode() {
    setPending(true); setError(null)
    const supabase = createClient()
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: code.trim(),
      type: 'email',
    })
    setPending(false)
    if (error) {
      setError('That code is invalid or expired. Check the digits or resend.')
      codeRef.current?.focus()
      codeRef.current?.select()
      return
    }
    router.push('/app') // middleware routes new users on to /app/onboarding
  }

  return (
    <main className="app-shell relative flex min-h-[100dvh] items-center justify-center overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[55dvh] overflow-hidden">
        <div className="absolute left-1/2 top-0 -translate-x-1/2 opacity-90">
          <DottedGlobe />
        </div>
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-[var(--night-void)] to-transparent" />
      </div>
      <section className="surface relative z-10 flex w-full max-w-sm flex-col gap-8 p-6">
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-3xl font-[family-name:var(--font-instrument-serif)] text-[color:var(--starlight)] italic">
            Astrail
          </h1>
          <p className="text-sm text-[color:var(--starlight)]/50 font-[family-name:var(--font-geist)]">
            Turn travel Reels into a route you&apos;ll actually take.
          </p>
        </div>

        {step === 'email' ? (
          <form
            className="flex w-full flex-col gap-3"
            onSubmit={(e) => { e.preventDefault(); void sendCode() }}
          >
            <label htmlFor="email" className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)]">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="surface type-body rounded-lg p-2.5 text-sm text-[var(--starlight)] placeholder:text-[var(--faint)]"
            />
            <button
              type="submit"
              disabled={pending || !email.trim()}
              className="type-label rounded-lg border border-[var(--brass)] bg-[var(--brass-soft)] px-4 py-3 text-sm uppercase tracking-wide text-[var(--starlight)] disabled:opacity-40"
            >
              {pending ? 'Sending…' : 'Email me a code'}
            </button>
          </form>
        ) : (
          <form
            className="flex w-full flex-col gap-3"
            onSubmit={(e) => { e.preventDefault(); void verifyCode() }}
          >
            <label htmlFor="otp" className="type-label text-[11px] uppercase tracking-wide text-[var(--muted)]">
              6-digit code
            </label>
            <input
              id="otp"
              ref={codeRef}
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="123456"
              className="surface type-body rounded-lg p-2.5 text-center text-lg tracking-[0.4em] text-[var(--starlight)] placeholder:text-[var(--faint)]"
            />
            <button
              type="submit"
              disabled={pending || code.trim().length !== 6}
              className="type-label rounded-lg border border-[var(--brass)] bg-[var(--brass-soft)] px-4 py-3 text-sm uppercase tracking-wide text-[var(--starlight)] disabled:opacity-40"
            >
              {pending ? 'Verifying…' : 'Sign in'}
            </button>
            <button
              type="button"
              onClick={() => void sendCode()}
              disabled={pending || cooldown > 0}
              className="type-label min-h-11 text-[11px] uppercase tracking-wide text-[var(--muted)] underline-offset-2 hover:underline disabled:opacity-40"
            >
              {cooldown > 0 ? `Resend code (${cooldown}s)` : 'Resend code'}
            </button>
            <button
              type="button"
              onClick={() => { setStep('email'); setCode(''); setError(null); setNotice(null) }}
              className="type-label min-h-11 text-[11px] uppercase tracking-wide text-[var(--faint)] underline-offset-2 hover:underline"
            >
              Use a different email
            </button>
          </form>
        )}

        {notice ? <p className="type-body text-xs text-[var(--muted)]">{notice}</p> : null}
        {error ? <p className="type-body text-xs text-[var(--fail)]" role="alert">{error}</p> : null}
      </section>
    </main>
  )
}
