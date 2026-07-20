'use client'

// Root error boundary: catches render errors on the landing and sign-in routes.
// /app routes are caught first by app/app/error.tsx, which keeps the segment layout.
export { default } from '@/components/system/ErrorScreen'
