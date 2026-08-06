import { describe, it, expect } from 'vitest'
import { sourceLabel } from '@/lib/reels/labels'
import { normalizeReelUrl } from '@/lib/trip/parse-inspiration'

describe('sourceLabel', () => {
  it('reads a /reel/ URL as Reel', () => {
    expect(sourceLabel('https://www.instagram.com/reel/ABC123/')).toBe('Reel')
    expect(sourceLabel('https://www.instagram.com/reel/ABC123')).toBe('Reel')
  })

  it('reads a /p/ post URL as Post', () => {
    expect(sourceLabel('https://www.instagram.com/p/DQwdZ8ZCWZx/')).toBe('Post')
    expect(sourceLabel('https://www.instagram.com/p/DQwdZ8ZCWZx')).toBe('Post')
  })

  it('reads a /tv/ URL as Post once canonicalized to /p/', () => {
    const canonical = normalizeReelUrl('https://www.instagram.com/tv/TV123/')!
    expect(canonical).toBe('https://www.instagram.com/p/TV123/')
    expect(sourceLabel(canonical)).toBe('Post')
  })

  it('does not false-positive on a reel shortcode that contains "p"', () => {
    expect(sourceLabel('https://www.instagram.com/reel/Ppa1p/')).toBe('Reel')
  })
})
