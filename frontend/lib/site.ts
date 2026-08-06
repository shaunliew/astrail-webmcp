// Canonical origin for every absolute URL the app emits — metadataBase (OG/Twitter
// tags), sitemap.xml, robots.txt. Keep this the single source of truth so the three
// never drift.
//
// Precedence:
//   1. NEXT_PUBLIC_SITE_URL          — set in Vercel to the public host you want indexed.
//   2. VERCEL_PROJECT_PRODUCTION_URL — Vercel's own production domain, so prod/preview
//                                      builds self-resolve even if (1) is unset.
//   3. https://astrail.xyz           — final fallback for local dev.
function resolveSiteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL
  if (explicit) return explicit.replace(/\/+$/, "")

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL
  if (vercel) return `https://${vercel.replace(/\/+$/, "")}`

  return "https://astrail.xyz"
}

/** Origin with no trailing slash, e.g. `https://app.astrail.xyz`. */
export const SITE_URL = resolveSiteUrl()

/** Same origin as a URL object — what `metadata.metadataBase` expects. */
export const SITE_ORIGIN = new URL(SITE_URL)
