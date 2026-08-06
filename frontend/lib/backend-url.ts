// Single source of truth for the FastAPI backend base URL, shared by
// lib/reels/api.ts and lib/trip/api.ts so the production guard lives in exactly
// one place instead of being duplicated (and drifting) across call sites.

const LOCAL_DEV_BACKEND_URL = 'http://localhost:8000'

/**
 * Resolves the backend base URL from NEXT_PUBLIC_BACKEND_URL.
 *
 * Local development falls back to http://localhost:8000 when the variable is
 * unset or empty. Production (NODE_ENV === 'production') has NO fallback: an
 * unset/empty variable throws so the Vercel build fails LOUDLY, rather than
 * silently shipping a bundle that points every backend write at localhost.
 */
export function resolveBackendUrl(): string {
  const configured = process.env.NEXT_PUBLIC_BACKEND_URL?.trim()
  if (configured) return configured
  if (process.env.NODE_ENV === 'production') {
    throw new Error('NEXT_PUBLIC_BACKEND_URL is required in production')
  }
  return LOCAL_DEV_BACKEND_URL
}
