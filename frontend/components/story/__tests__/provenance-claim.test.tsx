import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { render } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import HowItWorks from '../sections/HowItWorks'
import LiveMapDemo from '../sections/LiveMapDemo'

/**
 * The provenance claim, which is the sentence the whole entry rests on.
 *
 * Astrail's argument is that nothing reaches the map unattributed. The seductive version of that
 * — "every stop carries the Reel caption it came from" — is FALSE and always was: three source
 * types exist, and only reel-derived stops are promised a quote. A claims audit found it in five
 * places at once, and `LiveMapDemo` was carrying it ("the reel and quote behind each stop") while
 * the whole suite ran green, because nothing was watching. That is the reason this file exists:
 * the false version reads better than the true one, so it will be written again.
 *
 * WHAT IS ASSERTED IS THE MEANING, NOT THE WORDING. The copy is meant to be rewritten — it is
 * marketing on a page a judge reads first. A test pinning exact strings would either block every
 * edit or be deleted by the first person it blocked. So:
 *
 *   1. the copy must ACCOUNT for every `PlaceSourceType` the schema declares, read from the
 *      schema rather than listed here — so adding a fourth kind of stop reddens this until the
 *      page admits the fourth kind exists;
 *   2. the copy must not promise a caption quote for a stop that has none, in either of the two
 *      shapes that mistake actually takes.
 *
 * What it CANNOT catch, stated so nobody trusts it further than it goes: a universal quote claim
 * phrased without the words this file looks for. It is a floor, not a proof. The regexes below
 * are matched against the RENDERED text, so copy that never reaches the screen cannot satisfy it.
 */

/** The schema is the authority on how many kinds of stop exist. This file is not. */
const SOURCE_TYPES = (() => {
  const src = readFileSync(resolve(process.cwd(), 'lib/trip/backend-types.ts'), 'utf8')
  const decl = src.match(/export type PlaceSourceType = ([^\n]+)/)?.[1] ?? ''
  return [...decl.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
})()

/**
 * How the copy has to express each source type. Deliberately loose: several honest phrasings
 * satisfy each one, which is the point — "or to you", "you asked for", "a stop you asked for
 * yourself" all say the same true thing.
 */
const MUST_NAME: Record<string, RegExp> = {
  reel_extracted: /reel/i,
  agent_suggested: /suggest|reasoning/i,
  user_requested: /you asked|asked for|to you\b/i,
}

/** "every stop … quote" — the claim the audit found in five places. */
const QUOTE_PROMISED_TO_ALL = /\b(every|each|any|all)\s+stops?\b[^.]{0,60}\b(quote|caption)\b/i
/** "the quote behind each stop" — the same lie with the clauses swapped, and the exact wording
    `LiveMapDemo` shipped. Both directions, because fixing one is not fixing the claim. */
const QUOTE_BEHIND_ALL = /\b(quote|caption)\b[^.]{0,40}\b(behind|for|on)\s+(each|every|any|all)\s+stops?\b/i

const SECTIONS = [
  ['How it works', HowItWorks],
  ['Live map demo', LiveMapDemo],
] as const

/** One paragraph's worth of rendered words, whitespace collapsed so a line break is not a gap. */
const copyOf = (Section: (typeof SECTIONS)[number][1]): string =>
  (render(<Section />).container.textContent ?? '').replace(/\s+/g, ' ')

beforeAll(() => {
  // jsdom has no IntersectionObserver, and `LiveMapDemo` gates its WebGL map behind `useInView`.
  // Stubbed rather than mocking the component, because the copy under test sits above that gate
  // and a mocked section would prove nothing about the page.
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      root = null
      rootMargin = ''
      thresholds: number[] = []
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return []
      }
    },
  )
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('the provenance claim on the landing page', () => {
  it('reads the source types out of the schema at all (guards the guard)', () => {
    // Without this, a parse that silently returns [] makes every assertion below vacuous.
    expect(SOURCE_TYPES.length).toBeGreaterThan(0)
    expect(SOURCE_TYPES).toContain('reel_extracted')
  })

  it('has a rule for every source type the schema declares, and no invented ones', () => {
    // The failure this exists for: someone adds a fourth `PlaceSourceType` and the landing page
    // goes on describing three. The page would still be green and would now be understating a
    // product that grew — which costs the same marks as overstating one that did not.
    expect(Object.keys(MUST_NAME).sort()).toEqual(SOURCE_TYPES)
  })

  it.each(SECTIONS)('%s names where every kind of stop came from', (_name, Section) => {
    const copy = copyOf(Section)

    for (const type of SOURCE_TYPES) {
      expect(copy, `the copy never accounts for ${type}`).toMatch(MUST_NAME[type])
    }
  })

  it.each(SECTIONS)('%s never promises a caption quote for a stop that has none', (_name, Section) => {
    const copy = copyOf(Section)

    expect(copy, 'promises a quote for every stop').not.toMatch(QUOTE_PROMISED_TO_ALL)
    expect(copy, 'promises a quote behind every stop').not.toMatch(QUOTE_BEHIND_ALL)
  })
})
