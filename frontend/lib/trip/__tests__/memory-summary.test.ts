import { describe, it, expect } from 'vitest'
import type { MemoryFact } from '@/lib/trip/backend-types'
import { MEMORY_SUMMARY_MAX_CHARS, MEMORY_SUMMARY_MAX_FACTS, summarizeMemoryFacts } from '../memory-summary'

const fact = (memory: string, id = memory.slice(0, 8)): MemoryFact =>
  ({ id, memory, created_at: '2026-01-01T00:00:00Z', source: 'mem0' })

/**
 * One sentence naming what Astrail holds, shared by the two surfaces that state it: the home
 * page's line and the approval card the user reads before spending their allowance.
 *
 * Shared because they must not drift. A user who reads "Astrail remembers: X" on the home screen
 * and then approves a card naming Y has been told two different things about the same store.
 */
describe('summarizeMemoryFacts', () => {
  it('names what is remembered, in the order it came back', () => {
    expect(summarizeMemoryFacts([fact('Prefers walkable days'), fact('Loves ramen')]))
      .toBe('Prefers walkable days · Loves ramen')
  })

  it('shows only the first few, however many an account has', () => {
    /* mem0 has no ceiling on what one account accumulates. Unbounded, this is a home-page line
       that grows into a wall and a card whose actual decision — "this uses your trip allowance" —
       gets pushed off the bottom. */
    const many = Array.from({ length: 12 }, (_, i) => fact(`Fact ${i}`, `m${i}`))
    const line = summarizeMemoryFacts(many)!
    expect(line.split(' · ')).toHaveLength(MEMORY_SUMMARY_MAX_FACTS)
    expect(line).toContain('Fact 0')
    expect(line).not.toContain(`Fact ${MEMORY_SUMMARY_MAX_FACTS}`)
  })

  it('truncates a single memory long enough to be a wall on its own', () => {
    // The cap on the COUNT does not bound the LENGTH: one memory can be arbitrarily long, and
    // mem0 prose can reach the store through the agent's `preferences` argument.
    const line = summarizeMemoryFacts([fact('x'.repeat(1_000))])!
    expect(line.length).toBeLessThanOrEqual(MEMORY_SUMMARY_MAX_CHARS + 1)
    expect(line.endsWith('…')).toBe(true)
  })

  it('says nothing rather than something empty', () => {
    // The callers render nothing at all on null. A bare "Astrail remembers:" with an empty tail
    // would be the home page claiming a memory it does not have.
    expect(summarizeMemoryFacts([])).toBeNull()
    expect(summarizeMemoryFacts([fact('   ', 'blank')])).toBeNull()
  })

  it('survives a payload that is not the shape it was promised', () => {
    /* The response is parsed straight out of JSON, so `memory` is whatever came over the wire.
       A non-string here used to be a render of `undefined` in the middle of the sentence. */
    const malformed = [{ id: 'a', memory: null }, fact('Loves ramen')] as unknown as MemoryFact[]
    expect(summarizeMemoryFacts(malformed)).toBe('Loves ramen')
  })

  /* NEWLINES ARE THE ATTACK, and the character cap does not see them.
     The approval card renders this text with `whitespace-pre-line` and no height bound, so a
     memory that is 160 characters of "x\n" is ~80 visual lines — enough to push Approve and
     Not now off the screen. React escapes the text, so this is not XSS; it is the consent gate
     being made unreachable by content that arrives through the agent's own `preferences`
     argument. Found by a cross-model review, not by this suite. */
  it('cannot turn one memory into eighty lines', () => {
    const out = summarizeMemoryFacts([
      { id: 'm', memory: 'a\n'.repeat(80), created_at: '2026-01-01T00:00:00Z', source: 'mem0' },
    ])
    expect(out, 'a newline survived into the approval card').not.toMatch(/\n/)
  })

  it('collapses every kind of internal whitespace, not just the ends', () => {
    const out = summarizeMemoryFacts([
      { id: 'm', memory: '  walkable\t\tdays \r\n and   ramen  ', created_at: '2026-01-01T00:00:00Z', source: 'mem0' },
    ])
    expect(out).toBe('walkable days and ramen')
  })

  /* The card presents this list as what Astrail will try to recall, but the pipeline searches the
     WHOLE store — a differently ordered superset. Naming three of five silently would let someone
     approve against a list and then be steered by a memory that list never mentioned. */
  it('says how many memories it did not name', () => {
    const facts = ['one', 'two', 'three', 'four', 'five'].map((m) => (
      { id: m, memory: m, created_at: '2026-01-01T00:00:00Z', source: 'mem0' as const }
    ))
    expect(summarizeMemoryFacts(facts)).toMatch(/\(and 2 more\)/)
  })

  it('says nothing about omissions when it named everything', () => {
    const facts = ['one', 'two'].map((m) => (
      { id: m, memory: m, created_at: '2026-01-01T00:00:00Z', source: 'mem0' as const }
    ))
    expect(summarizeMemoryFacts(facts)).not.toMatch(/more\)/)
  })

  it('keeps the ellipsis inside the advertised maximum', () => {
    // The constant is a MAXIMUM; a caller sizing against it must not be handed 161 characters.
    const long = [{ id: 'm', memory: 'x'.repeat(500), created_at: '2026-01-01T00:00:00Z', source: 'mem0' as const }]
    expect((summarizeMemoryFacts(long) ?? '').length).toBeLessThanOrEqual(MEMORY_SUMMARY_MAX_CHARS)
  })
})
