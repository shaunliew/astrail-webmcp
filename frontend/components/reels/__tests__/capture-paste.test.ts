import { describe, it, expect } from 'vitest'

/**
 * The paste-splitting rule, extracted so it can be asserted without mounting the screen.
 * Mirrors spreadPastedLinks in TraysScreen.
 */
function split(raw: string): string[] {
  return raw.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean)
}

const MAX = 5

/** How the rows end up after pasting `raw` into row `index`. */
function spread(rows: string[], index: number, raw: string): string[] {
  const found = split(raw)
  if (found.length < 2) return rows
  const next = [...rows]
  next[index] = found[0]
  for (const link of found.slice(1)) {
    if (next.length >= MAX) break
    const blank = next.findIndex((u, j) => j > index && !u.trim())
    if (blank >= 0) next[blank] = link
    else next.push(link)
  }
  return next
}

const A = 'https://www.instagram.com/reel/AAA/'
const B = 'https://www.instagram.com/reel/BBB/'
const C = 'https://www.instagram.com/reel/CCC/'

describe('pasting several Reel links at once', () => {
  it('fills a row per link instead of making the user click "+ Add another link"', () => {
    // The product exists to remove copy-paste friction. Requiring five separate clicks to add
    // five links put it right back.
    expect(spread([''], 0, `${A}\n${B}\n${C}`)).toEqual([A, B, C])
  })

  it('handles the separators people actually paste', () => {
    expect(spread([''], 0, `${A} ${B}`)).toEqual([A, B])
    expect(spread([''], 0, `${A}, ${B}`)).toEqual([A, B])
    expect(spread([''], 0, `${A}\r\n${B}`)).toEqual([A, B])
  })

  it('leaves a single-link paste completely alone', () => {
    // Normal typing and single pastes must keep the browser's own behaviour.
    expect(spread(['', ''], 0, A)).toEqual(['', ''])
  })

  it('fills blank rows before appending, never overwriting typed input', () => {
    const rows = ['', '', 'https://www.instagram.com/reel/TYPED/']
    const out = spread(rows, 0, `${A}\n${B}`)
    expect(out[0]).toBe(A)
    expect(out[1]).toBe(B)
    expect(out[2]).toBe('https://www.instagram.com/reel/TYPED/')
  })

  it('stops at the 5-link cap the backend also enforces', () => {
    const many = Array.from({ length: 9 }, (_, i) => `https://www.instagram.com/reel/R${i}/`)
    expect(spread([''], 0, many.join('\n'))).toHaveLength(MAX)
  })

  it('ignores stray whitespace and empty lines', () => {
    expect(spread([''], 0, `\n\n  ${A}   \n\n  ${B}\n`)).toEqual([A, B])
  })
})
