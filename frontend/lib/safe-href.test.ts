import { describe, expect, it } from 'vitest'

import { safeHref } from './safe-href'

describe('safeHref', () => {
  it('passes http and https URLs through unchanged', () => {
    expect(safeHref('https://instagram.com/reel/abc')).toBe('https://instagram.com/reel/abc')
    expect(safeHref('http://example.com/x')).toBe('http://example.com/x')
  })

  it('rejects the javascript: scheme (the XSS vector)', () => {
    expect(safeHref('javascript:alert(1)')).toBeUndefined()
    expect(safeHref('JavaScript:alert(1)')).toBeUndefined()
  })

  it('rejects data: and other non-http schemes', () => {
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeUndefined()
    expect(safeHref('vbscript:msgbox(1)')).toBeUndefined()
    expect(safeHref('file:///etc/passwd')).toBeUndefined()
  })

  it('returns undefined for empty/nullish input', () => {
    expect(safeHref(null)).toBeUndefined()
    expect(safeHref(undefined)).toBeUndefined()
    expect(safeHref('')).toBeUndefined()
  })

  it('allows a relative URL (resolves to https against the origin)', () => {
    expect(safeHref('/app/trip/123')).toBe('/app/trip/123')
  })
})
