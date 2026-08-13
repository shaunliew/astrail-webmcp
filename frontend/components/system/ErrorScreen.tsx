'use client'

// Composed runtime-error screen shared by both error boundaries (app/error.tsx and
// app/app/error.tsx) so their rendering cannot drift. Self-applies .app-shell, the
// pattern TripsList and OnboardingWizard already use, so it renders the same night
// world whether the segment layout survived the error or not.
//
// Guardrail #2: never surface raw error text — error.digest is the only identifier
// shown. The mascot is idle: nothing is in flight, and animating a terminal state
// is motion telling a lie (globals.css).

import { useEffect } from 'react'
import * as Sentry from '@sentry/nextjs'
import Astronaut from '@/components/mascot/Astronaut'

type ErrorScreenProps = {
  error: Error & { digest?: string }
  reset: () => void
}

export default function ErrorScreen({ error, reset }: ErrorScreenProps) {
  // Full detail belongs in the console, not the UI.
  useEffect(() => {
    Sentry.captureException(error)
    console.error(error)
  }, [error])

  return (
    <main className="app-shell flex min-h-[100dvh] flex-col items-center justify-center gap-4 p-6 text-center">
      <Astronaut size={48} />
      <h1 className="type-display text-3xl text-[var(--starlight)]">Lost signal</h1>
      <p className="type-body max-w-sm text-sm text-[var(--muted)]">
        Something went wrong while drawing this screen.
      </p>
      {error.digest ? (
        <p className="type-label text-[10px] uppercase tracking-wide text-[var(--faint)]">
          Ref {error.digest}
        </p>
      ) : null}
      <button
        type="button"
        onClick={reset}
        className="type-label mt-2 rounded-lg border border-[var(--brass)] bg-[var(--brass-glow)] px-4 py-3 text-sm uppercase tracking-wide text-[var(--starlight)] transition-colors hover:bg-[rgba(201,151,78,0.38)]"
      >
        Try again
      </button>
    </main>
  )
}
