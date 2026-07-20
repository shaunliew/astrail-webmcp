'use client'

// /app-segment error boundary: renders inside app/app/layout.tsx's .app-shell,
// so product errors keep the night shell around them.
export { default } from '@/components/system/ErrorScreen'
