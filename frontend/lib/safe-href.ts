/**
 * Return `url` only when it is an http(s) URL; otherwise `undefined`.
 *
 * Defense-in-depth for `<a href>` sinks fed by backend-supplied URLs (evidence source_url, reel
 * normalized_url, etc.). React does NOT sanitize the `javascript:` scheme in an href, so a
 * `javascript:`/`data:` value reaching one of these would be click-to-execute XSS. The backend
 * already enforces http(s) on these fields (place_extractor.is_placeholder_url; reel URLs are
 * https-by-construction), so this is a second line, not the only line — it keeps a future backend
 * change from turning an evidence link into an exploit. Gate the whole <a> on it so an unsafe URL
 * renders nothing rather than a dead, misleading link:
 *
 *   const href = safeHref(evidence.source_url)
 *   {href ? <a href={href} ...>…</a> : null}
 */
export function safeHref(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  try {
    // Resolve against a base so a legitimately relative URL still parses; absolute URLs ignore it.
    const base = typeof window !== 'undefined' ? window.location.origin : 'https://astrail.xyz'
    const protocol = new URL(url, base).protocol
    return protocol === 'http:' || protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}
