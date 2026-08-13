'use client'

import { useEffect } from 'react'
import * as Sentry from '@sentry/nextjs'

type GlobalErrorProps = {
  error: Error & { digest?: string }
  reset: () => void
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  useEffect(() => {
    Sentry.captureException(error)
    console.error(error)
  }, [error])

  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#101720', color: '#f6f0e4', fontFamily: 'system-ui, sans-serif' }}>
        <main style={{ minHeight: '100dvh', display: 'grid', placeContent: 'center', gap: 16, padding: 24, textAlign: 'center' }}>
          <h1 style={{ margin: 0, fontSize: 36 }}>Lost signal</h1>
          <p style={{ margin: 0, color: '#b5aea1' }}>Something went wrong while opening Astrail.</p>
          {error.digest ? <p style={{ margin: 0, color: '#81796d', fontSize: 12 }}>Ref {error.digest}</p> : null}
          <button
            type="button"
            onClick={reset}
            style={{ justifySelf: 'center', border: '1px solid #c9974e', borderRadius: 8, background: '#3b3024', color: '#f6f0e4', padding: '12px 18px', cursor: 'pointer' }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  )
}
