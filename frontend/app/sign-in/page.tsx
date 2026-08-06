'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { DoorBrand, DoorStage, FOCUS_RING } from '@/components/door/DoorChrome'

// Supabase rate-limits OTP sends (~1/min) — surface the wait, don't let users hit the raw error.
const RESEND_COOLDOWN_S = 60

function looksLikeEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim())
}

/* Official four-colour Google mark. The only place four foreign colours appear on the
   screen — they live inside the glyph, never in the five-role palette (resolves DESIGN.md
   §9's open "monochrome G" blocker: a compliant button rather than a recoloured logo). */
function GoogleG() {
  return (
    <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden className="shrink-0">
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.167 6.656 3.58 9 3.58z" />
    </svg>
  )
}

/* Leading input glyph (lucide "mail", inlined — same choice as GoogleG above, so the sign-in
   pulls in no icon dependency). Stroke = currentColor, so it inherits the label's muted ink. */
function MailIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </svg>
  )
}

export default function SignInPage() {
  const router = useRouter()
  const [step, setStep] = useState<'email' | 'code'>('email')
  const [email, setEmail] = useState('')
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', ''])
  const [pending, setPending] = useState(false)
  const [emailError, setEmailError] = useState<string | null>(null)
  const [codeError, setCodeError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [cooldown, setCooldown] = useState(0)
  const otpRefs = useRef<(HTMLInputElement | null)[]>([])

  const code = digits.join('')
  const emailValid = looksLikeEmail(email)

  // Surface an OAuth round-trip failure handed back by /auth/callback (?error=auth_failed).
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (new URLSearchParams(window.location.search).get('error') === 'auth_failed') {
      setEmailError('Google sign-in didn’t complete. Try again, or use an email code.')
    }
  }, [])

  // Resend cooldown ticker.
  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  // Focus the first code box when the code step appears.
  useEffect(() => {
    if (step === 'code') otpRefs.current[0]?.focus()
  }, [step])

  async function signInWithGoogle() {
    setPending(true)
    setEmailError(null)
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback?next=/app` },
    })
    // On success the browser is already navigating to Google; only reachable on error.
    if (error) {
      setPending(false)
      setEmailError(error.message)
    }
  }

  async function sendCode() {
    if (!emailValid) return
    setPending(true)
    setEmailError(null)
    setCodeError(null)
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: true }, // one door: sign-up and sign-in are the same flow
    })
    setPending(false)
    if (error) {
      setEmailError(error.message)
      return
    }
    setDigits(['', '', '', '', '', ''])
    setStep('code')
    setCooldown(RESEND_COOLDOWN_S)
    setNotice(`We sent a 6-digit code to ${email.trim()}.`)
  }

  async function verifyCode() {
    if (code.length !== 6) return
    setPending(true)
    setCodeError(null)
    const supabase = createClient()
    const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code, type: 'email' })
    setPending(false)
    if (error) {
      setCodeError('That code didn’t match. Codes expire after 10 minutes, so use the newest email.')
      setDigits(['', '', '', '', '', ''])
      otpRefs.current[0]?.focus()
      return
    }
    router.push('/app') // middleware routes new users on to /app/onboarding
  }

  function setDigit(i: number, value: string) {
    setDigits((prev) => {
      const next = [...prev]
      next[i] = value
      return next
    })
  }

  function onOtpChange(i: number, raw: string) {
    const d = raw.replace(/\D/g, '').slice(-1)
    setDigit(i, d)
    setCodeError(null)
    if (d && i < 5) otpRefs.current[i + 1]?.focus()
  }

  function onOtpKeyDown(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[i] && i > 0) {
      otpRefs.current[i - 1]?.focus()
    }
  }

  // One paste of "384012" fills all six — what people actually do.
  function onOtpPaste(i: number, e: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '')
    if (!pasted) return
    e.preventDefault()
    setDigits((prev) => {
      const next = [...prev]
      for (let n = 0; n < pasted.length && i + n < 6; n++) next[i + n] = pasted[n]
      return next
    })
    setCodeError(null)
    otpRefs.current[Math.min(i + pasted.length, 5)]?.focus()
  }

  return (
    <DoorStage caption="Nothing on your map yet.">
      <DoorBrand />

      {step === 'email' ? (
        <section>
          {/* Card header — shadcn pattern: title + one muted supporting line. The title is the
              promise, not the word "Sign in" (DESIGN.md §9); the description carries the model. */}
          <header className="mb-6">
            <h1
              className="font-display text-[24px] font-medium leading-[1.16] tracking-[-0.015em]"
              style={{ fontVariationSettings: "'SOFT' 28, 'WONK' 1, 'opsz' 24" }}
            >
              Your saved Reels, as one route.
            </h1>
            <p className="mt-2 text-[14px] leading-[1.4] text-[color:var(--text-muted)]">
              Sign in or create your account. No password — we email you a code.
            </p>
          </header>

          <div className="space-y-5">
            {/* Social sign-in. One provider, so a full-width labelled button reads cleaner than a
                single-cell icon grid — but the "Sign in with" caption keeps the shadcn shape. */}
            <div className="space-y-2">
              <p className="text-[12px] font-medium text-[color:var(--text-muted)]">Sign in with</p>
              <button
                type="button"
                onClick={() => void signInWithGoogle()}
                disabled={pending}
                className={`flex min-h-11 w-full items-center justify-center gap-2.5 rounded-lg border border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)] px-5 text-[14px] font-medium text-[color:var(--text)] shadow-[0_1px_2px_rgba(28,23,16,0.06)] transition-[background,opacity] duration-150 hover:bg-[color:var(--surface-2)] disabled:cursor-default disabled:opacity-60 ${FOCUS_RING}`}
              >
                <GoogleG />
                Continue with Google
              </button>
            </div>

            {/* Divider — the shadcn "or" rule. The pill sits on the card surface (--surface-1). */}
            <div className="relative">
              <div className="absolute inset-0 flex items-center" aria-hidden>
                <span className="w-full border-t border-[color:var(--line-soft)]" />
              </div>
              <div className="relative flex justify-center text-[11px] uppercase tracking-[0.08em]">
                <span className="bg-[color:var(--surface-1)] px-2 text-[color:var(--text-faint)]">or</span>
              </div>
            </div>

            {/* Email code form. Labelled input with a leading glyph — the shadcn input pattern. */}
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void sendCode()
              }}
              className="space-y-4"
            >
              <div className="space-y-2">
                <label htmlFor="email" className="block text-[13px] font-medium text-[color:var(--text)]">
                  Email
                </label>
                <div className="relative">
                  <MailIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--text-muted)]" />
                  <input
                    id="email"
                    type="email"
                    required
                    autoComplete="email"
                    inputMode="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value)
                      setEmailError(null)
                    }}
                    onBlur={() => {
                      const v = email.trim()
                      if (v.length > 0 && !looksLikeEmail(v)) {
                        setEmailError('That doesn’t look like an email address.')
                      }
                    }}
                    placeholder="you@example.com"
                    aria-invalid={emailError ? true : undefined}
                    aria-describedby={emailError ? 'emailErr' : undefined}
                    className={`min-h-11 w-full rounded-lg border bg-[color:var(--surface-1)] pl-9 pr-4 text-[color:var(--text)] placeholder:text-[color:var(--text-faint)] ${FOCUS_RING} ${
                      emailError ? 'border-[color:var(--fail)]' : 'border-[color:var(--line-soft)]'
                    }`}
                  />
                </div>
                {emailError ? (
                  <p id="emailErr" role="alert" className="flex items-center gap-1.5 text-[13px] text-[color:var(--fail)]">
                    <span aria-hidden>✕</span>
                    {emailError}
                  </p>
                ) : null}
              </div>

              {/* Primary action of this step: brass fill (the shadcn solid primary weight).
                  Disabled states its own blocker — dashed + muted, never a dead grey slab. */}
              <button
                type="submit"
                disabled={!emailValid || pending}
                className={`flex min-h-11 w-full items-center justify-center rounded-lg border border-[color:var(--accent)] bg-[color:var(--accent)] px-5 text-[14px] font-medium text-[color:var(--accent-text)] transition-opacity duration-150 hover:opacity-90 disabled:cursor-default disabled:border-dashed disabled:border-[color:var(--line-soft)] disabled:bg-transparent disabled:text-[color:var(--text-muted)] disabled:hover:opacity-100 ${FOCUS_RING}`}
              >
                {pending ? 'Sending…' : emailValid ? 'Email me a 6-digit code' : 'Waiting for your email'}
              </button>
            </form>
          </div>

          <p className="mt-5 text-center text-[12px] leading-[1.5] text-[color:var(--text-faint)]">
            By continuing with Google or email, you agree to our{' '}
            <a href="/terms" className="underline underline-offset-2 hover:text-[color:var(--text-muted)]">Terms</a>{' '}
            and{' '}
            <a href="/privacy" className="underline underline-offset-2 hover:text-[color:var(--text-muted)]">Privacy&nbsp;Policy</a>.
          </p>
          <p className="mt-6 border-t border-[color:var(--line-soft)] pt-4 text-[13px] text-[color:var(--text-muted)]">
            No account? Enter your email and we’ll make you one. We only ever send sign-in codes.
          </p>
        </section>
      ) : (
        <section>
          <button
            type="button"
            onClick={() => {
              setStep('email')
              setCodeError(null)
              setNotice(null)
            }}
            className={`-ml-3 mb-4 inline-flex min-h-9 items-center rounded-lg px-3 text-[13px] font-medium text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)] ${FOCUS_RING}`}
          >
            ← Use a different email
          </button>

          <h1
            className="mb-4 font-display text-[22px] font-medium leading-[1.22] tracking-[-0.015em]"
            style={{ fontVariationSettings: "'SOFT' 28, 'WONK' 1, 'opsz' 22" }}
          >
            Check your email
          </h1>
          <p className="mb-6 text-[14px] text-[color:var(--text-muted)]">
            We sent a 6-digit code to <b className="font-mono text-[color:var(--text)]">{email.trim()}</b>. It works for 10
            minutes.
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              void verifyCode()
            }}
          >
            <label htmlFor="otp1" className="sr-only">
              Your 6-digit code
            </label>
            <div className="mb-6 flex gap-2">
              {digits.map((d, i) => (
                <input
                  key={i}
                  id={i === 0 ? 'otp1' : undefined}
                  ref={(el) => {
                    otpRefs.current[i] = el
                  }}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  autoComplete={i === 0 ? 'one-time-code' : 'off'}
                  aria-label={`Digit ${i + 1}`}
                  value={d}
                  onChange={(e) => onOtpChange(i, e.target.value)}
                  onKeyDown={(e) => onOtpKeyDown(i, e)}
                  onPaste={(e) => onOtpPaste(i, e)}
                  className={`h-14 min-w-0 flex-1 rounded-lg border text-center font-mono text-[20px] tabular-nums text-[color:var(--text)] focus:outline focus:outline-2 focus:outline-[color:var(--brass-deep)] ${
                    d ? 'border-[color:var(--paper-line-2)] bg-[color:var(--surface-1)]' : 'border-[color:var(--line-soft)] bg-[color:var(--surface-2)]'
                  }`}
                />
              ))}
            </div>
            {codeError ? (
              <p role="alert" className="mb-6 -mt-3 flex items-center gap-1.5 text-[13px] text-[color:var(--fail)]">
                <span aria-hidden>✕</span>
                {codeError}
              </p>
            ) : null}

            {/* Primary action for this step: brass fill. Disabled states its blocker. */}
            <button
              type="submit"
              disabled={code.length !== 6 || pending}
              className={`flex min-h-11 w-full items-center justify-center rounded-lg border border-[color:var(--accent)] bg-[color:var(--accent)] px-5 text-[14px] font-medium text-[color:var(--accent-text)] transition-opacity duration-150 hover:opacity-90 disabled:cursor-default disabled:border-dashed disabled:border-[color:var(--line-soft)] disabled:bg-transparent disabled:text-[color:var(--text-muted)] disabled:hover:opacity-100 ${FOCUS_RING}`}
            >
              {pending ? 'Verifying…' : code.length === 6 ? 'Continue' : 'Waiting for your 6-digit code'}
            </button>
          </form>

          <button
            type="button"
            onClick={() => void sendCode()}
            disabled={cooldown > 0 || pending}
            className={`mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-lg px-3 text-[13px] font-medium tabular-nums text-[color:var(--text-muted)] hover:bg-[color:var(--surface-2)] disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent ${FOCUS_RING}`}
          >
            {cooldown > 0 ? `You can ask for a new code in ${cooldown}s` : 'Send me a new code'}
          </button>

          <p className="mt-6 border-t border-[color:var(--line-soft)] pt-4 text-[13px] text-[color:var(--text-muted)]">
            Nothing in your inbox? Check spam. The sender is{' '}
            <span className="whitespace-nowrap font-mono text-[color:var(--text)]">no-reply@astrail.app</span>.
          </p>
        </section>
      )}

      {/* Polite live region: announces the "code sent" confirmation to assistive tech. */}
      <p aria-live="polite" className="sr-only">
        {notice}
      </p>
    </DoorStage>
  )
}
