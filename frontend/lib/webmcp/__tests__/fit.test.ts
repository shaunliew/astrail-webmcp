import { describe, it, expect } from 'vitest'
import {
  envelopeLength,
  fitsBudget,
  fitBlocks,
  OUTPUT_LIMIT,
  OUTPUT_TARGET,
  type FitBlock,
} from '../fit'

// The whole point of fit.ts: the cap applies to the SERIALIZED envelope, not the raw string.
// If these first two tests ever pass with a naive text.length implementation, the budget is wrong.
describe('envelopeLength', () => {
  it('counts the MCP content envelope, not just the text', () => {
    expect(envelopeLength('')).toBeGreaterThan(30)
    expect(envelopeLength('hi')).toBe(JSON.stringify({ content: [{ type: 'text', text: 'hi' }] }).length)
  })

  it('counts an escaped newline as two characters', () => {
    // "ab" serializes to 2 chars; "a\nb" serializes to 4 (a, backslash, n, b).
    // That +2 per line is precisely why text.length under-counts line-dense itinerary output.
    expect(envelopeLength('a\nb') - envelopeLength('ab')).toBe(2)
  })

  it('under-counts by a wide margin if you measure text.length on line-dense output', () => {
    const lines = Array.from({ length: 40 }, (_, i) => ` ${i + 1} Some Place Name · reel`).join('\n')
    // The naive measure would pass the budget; the real one is materially larger.
    expect(lines.length).toBeLessThan(OUTPUT_LIMIT)
    expect(envelopeLength(lines)).toBeGreaterThan(lines.length)
  })
})

describe('fitsBudget', () => {
  it('accepts short output and rejects output past the hard cap', () => {
    expect(fitsBudget('Kyoto · 5 days')).toBe(true)
    expect(fitsBudget('x'.repeat(OUTPUT_LIMIT + 100))).toBe(false)
  })
})

const block = (key: string, lines: string[]): FitBlock => ({ key, lines })
const continuation = (dropped: string[]) =>
  `…days ${dropped.join(',')} omitted — call get_itinerary(day:${dropped[0]})`

describe('fitBlocks', () => {
  it('returns everything when it fits', () => {
    const out = fitBlocks({
      header: 'Kyoto · Mar 3-7 · 2 days · 4 stops · complete',
      blocks: [block('1', ['D1 Gion', ' 1 Fushimi Inari · reel']), block('2', ['D2 East', ' 2 Kiyomizu · you'])],
      footer: ['Stay: Hotel Kanra'],
      continuation,
    })
    expect(out).toContain('Fushimi Inari')
    expect(out).toContain('Kiyomizu')
    expect(out).toContain('Stay: Hotel Kanra')
    expect(fitsBudget(out)).toBe(true)
  })

  it('drops the footer before dropping itinerary content', () => {
    const blocks = Array.from({ length: 6 }, (_, d) =>
      block(String(d + 1), [
        `D${d + 1} A reasonably long day title here`,
        ...Array.from({ length: 5 }, (_, i) => ` ${d * 5 + i + 1} A Place With A Longish Name · reel`),
      ]),
    )
    const out = fitBlocks({
      header: 'Kyoto · Mar 3-12 · 6 days · 30 stops · complete',
      blocks,
      footer: ['Stay: Hotel Kanra (recommended, Shimogyo)', 'Gaps: day 4 has no transport legs'],
      continuation,
    })
    expect(out).not.toContain('Stay: Hotel Kanra')
    expect(out).toContain('D1')
  })

  it('never truncates mid-block — a half day would read as a complete but empty afternoon', () => {
    const blocks = Array.from({ length: 10 }, (_, d) =>
      block(String(d + 1), [
        `D${d + 1} Day title`,
        ...Array.from({ length: 4 }, (_, i) => ` ${d * 4 + i + 1} Place Name Here · reel`),
      ]),
    )
    const out = fitBlocks({ header: 'Big trip · 10 days · 40 stops', blocks, continuation })

    expect(fitsBudget(out)).toBe(true)
    // Every day that appears at all must carry its full complement of stops.
    for (let d = 1; d <= 10; d++) {
      if (!out.includes(`D${d} Day title`)) continue
      const stops = Array.from({ length: 4 }, (_, i) => ` ${(d - 1) * 4 + i + 1} Place Name Here`)
      for (const stop of stops) expect(out).toContain(stop)
    }
  })

  it('tells the agent how to recover what was dropped', () => {
    const blocks = Array.from({ length: 12 }, (_, d) =>
      block(String(d + 1), [
        `D${d + 1} Day title that is quite long to force truncation`,
        ...Array.from({ length: 5 }, (_, i) => ` ${d * 5 + i + 1} A Place With A Long Name · astrail`),
      ]),
    )
    const out = fitBlocks({ header: 'Huge trip · 12 days · 60 stops', blocks, continuation })
    expect(out).toContain('omitted — call get_itinerary')
    expect(fitsBudget(out)).toBe(true)
  })

  it('stays within budget for the worst realistic case (10 days / 40 stops)', () => {
    const blocks = Array.from({ length: 10 }, (_, d) =>
      block(String(d + 1), [
        `D${d + 1} Arashiyama and the western temples`,
        ...Array.from({ length: 4 }, (_, i) => ` ${d * 4 + i + 1} Tenryu-ji Temple Garden · reel`),
      ]),
    )
    const out = fitBlocks({
      header: 'Kyoto & Nara · Mar 3-12 · 10 days · 40 stops · complete',
      blocks,
      footer: ['Stay: Hotel Kanra'],
      continuation,
    })
    expect(envelopeLength(out)).toBeLessThanOrEqual(OUTPUT_TARGET)
  })

  it('degrades to a header plus a recovery instruction rather than emitting nothing', () => {
    const blocks = [block('1', ['D1 ' + 'x'.repeat(3000)])]
    const out = fitBlocks({ header: 'Trip', blocks, continuation })
    expect(out).toContain('Trip')
    expect(out).toContain('omitted')
    expect(fitsBudget(out)).toBe(true)
  })
})
